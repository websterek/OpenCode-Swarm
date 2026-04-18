import { tool } from "@opencode-ai/plugin";
import {
  readFile,
  writeFile,
  mkdir,
  cp,
  readdir,
  stat,
} from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Plugin directory — the folder this file lives in.
// The default .swarm/ template lives at <pluginDir>/.swarm/
// ---------------------------------------------------------------------------
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(PLUGIN_DIR, ".swarm");

// ---------------------------------------------------------------------------
// Helpers — general
// ---------------------------------------------------------------------------

async function readProjectFile(dir, relPath) {
  try {
    return await readFile(join(dir, relPath), "utf8");
  } catch {
    return null;
  }
}

// Parse YAML frontmatter between the opening --- and closing --- lines.
// Returns {} on failure.
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1]);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Extract the body of a "## Section Name" heading up to the next "## " or EOF.
// Strips surrounding --- fence lines used as visual separators in the files.
function extractSection(content, sectionName) {
  const re = new RegExp(
    `##\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const match = content.match(re);
  if (!match) return "";
  return match[1]
    .replace(/^\s*---\s*\n/, "")
    .replace(/\n\s*---\s*$/, "")
    .trim();
}

// Extract the system prompt from an agent .md file.
function extractSystemPrompt(content) {
  const fenced = content.match(
    /##\s+System Prompt\s*\n```[^\n]*\n([\s\S]*?)```/,
  );
  if (fenced) return fenced[1].trim();

  const plain = content.match(/##\s+System Prompt\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (plain) return plain[1].trim();

  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

// Resolve a short agent name (e.g. "backend_architect") to a relative path
// under .swarm/agents/, falling back to treating the value as a literal path.
function resolveAgentPath(raw) {
  const s = raw.trim();
  if (s.includes("/") || s.endsWith(".md")) return s;
  return `agents/${s}.md`;
}

// Load and parse an agent file. Returns null if the file cannot be read.
async function loadAgent(dir, rawName) {
  const relPath = resolveAgentPath(String(rawName));
  const content = await readProjectFile(dir, `.swarm/${relPath}`);
  if (!content) return null;
  const fm = parseFrontmatter(content);
  return {
    rawName,
    relPath,
    name: fm.name ?? String(rawName),
    model: fm.model ?? null,
    temperature: fm.temperature ?? null,
    systemPrompt: extractSystemPrompt(content),
  };
}

function extractText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

// Detect a VOTE line anywhere in the text. Defaults to REVISE (conservative).
function detectVote(text) {
  if (/VOTE:\s*APPROVE/i.test(text)) return "APPROVE";
  if (/VOTE:\s*REVISE/i.test(text)) return "REVISE";
  return "REVISE";
}

function fillTemplate(template, vars) {
  return Object.entries(vars).reduce(
    (t, [k, v]) => t.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), v ?? ""),
    template,
  );
}

async function appendLog(logPath, header, entry) {
  try {
    const existing = await readFile(logPath, "utf8");
    await writeFile(logPath, existing + "\n" + entry, "utf8");
  } catch {
    await writeFile(logPath, `# ${header}\n\n${entry}`, "utf8");
  }
}

// Run a single prompt in a temporary session and return the full text response.
// The session is always deleted afterwards.
async function runSession(client, dir, title, systemPrompt, promptText, agentModel = null) {
  let sessionId;
  try {
    const sessionConfig = { title };
    
    // If agentModel is provided, use it for this session
    if (agentModel) {
      sessionConfig.model = agentModel;
    }
    
    const created = await client.session.create({
      body: sessionConfig,
      query: { directory: dir },
    });
    sessionId = created.data.id;

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: systemPrompt,
        parts: [{ type: "text", text: promptText }],
      },
      query: { directory: dir },
    });

    return extractText(result.data.parts);
  } finally {
    if (sessionId) {
      try {
        await client.session.delete({
          path: { id: sessionId },
          query: { directory: dir },
        });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// Recursively collect all file paths under a directory, relative to that dir.
async function collectFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full, base)));
    } else {
      files.push(relative(base, full));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Helpers — run history
//
// Every tool invocation that produces output writes into a timestamped run
// directory:
//
//   .swarm/output/runs/<runId>/plan/        ← swarm_debate writes here
//   .swarm/output/runs/<runId>/build/       ← swarm_build_run writes here
//   .swarm/output/runs/<runId>/review/      ← swarm_review_run writes here
//
// After writing, the "current" files are also updated so the orchestrating
// agents can always reference stable paths:
//
//   .swarm/output/plan/consensus.md         ← copy of latest run's consensus
//   .swarm/output/plan/debate_log.md        ← copy of latest run's debate log
//   .swarm/output/build/build_log.md        ← copy of latest run's build log
//   .swarm/output/review/review_report.md   ← copy of latest run's report
//
// meta.json in each run directory records structured metadata about the run
// for future tooling (swarm_status, swarm_resume, etc.).
// ---------------------------------------------------------------------------

// Generate a filesystem-safe timestamp string: YYYY-MM-DD_HH-MM-SS
function makeRunId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

// Ensure a run directory exists and return its absolute path.
async function ensureRunDir(projectDir, runId, phase) {
  const runDir = join(projectDir, ".swarm/output/runs", runId, phase);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

// Write (or merge-update) the meta.json for a run/phase.
// Existing keys are preserved; new keys from `patch` are merged in.
async function writeMeta(runDir, patch) {
  const metaPath = join(runDir, "meta.json");
  let existing = {};
  try {
    existing = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    // file doesn't exist yet — start fresh
  }
  await writeFile(
    metaPath,
    JSON.stringify({ ...existing, ...patch }, null, 2),
    "utf8",
  );
}

// Copy a file from the run directory to the "current" output directory,
// creating the destination directory as needed.
async function publishCurrent(src, projectDir, currentRelPath) {
  const dest = join(projectDir, ".swarm", currentRelPath);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { force: true });
}

// ---------------------------------------------------------------------------
// Helpers — plan section extraction
//
// consensus.md is structured with ## headings per agent. For each build step
// only the relevant section (matching a heading name) is injected, keeping
// the builder session's context small instead of sending the entire plan.
// ---------------------------------------------------------------------------

// Extract a single ## section from plan content by heading name.
// Returns the full section text (heading + body) or null if not found.
function extractPlanSection(planContent, sectionName) {
  if (!planContent || !sectionName) return null;
  const re = new RegExp(
    `(##\\s+${escapeRegex(sectionName.trim())}\\s*\\n[\\s\\S]*?)(?=\\n##\\s|$)`,
    "i",
  );
  const m = planContent.match(re);
  return m ? m[1].trim() : null;
}

// List all ## heading names in a plan document (skips # top-level title).
function listPlanSections(planContent) {
  if (!planContent) return [];
  const re = /^##\s+(.+)$/gm;
  const names = [];
  let m;
  while ((m = re.exec(planContent)) !== null) {
    names.push(m[1].trim());
  }
  return names;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Helpers — status tracking & UI indicators
// ---------------------------------------------------------------------------

// Update status file to show current progress
async function updateStatus(dir, statusData) {
  const statusPath = join(dir, '.swarm/output/current_status.json');
  const fullStatus = {
    ...statusData,
    updatedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
  
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, JSON.stringify(fullStatus, null, 2), 'utf8');
  
  return fullStatus;
}

// Clear status when operation is complete
async function clearStatus(dir) {
  const statusPath = join(dir, '.swarm/output/current_status.json');
  try {
    await writeFile(statusPath, JSON.stringify({
      status: 'idle',
      message: 'No swarm operation in progress',
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch {
    // Ignore errors
  }
}

// Create a progress message with emojis
function createProgressMessage(phase, stage, agent, round, totalAgents, currentAgent) {
  const phases = {
    plan: '📋 Planning',
    build: '🔨 Building',
    review: '🔍 Reviewing'
  };
  
  const stages = {
    produce: 'Producing plan',
    cross_review: 'Cross-reviewing',
    compress: 'Compressing context',
    building: 'Building step',
    reviewing: 'Reviewing implementation'
  };
  
  const phaseText = phases[phase] || phase;
  const stageText = stages[stage] || stage;
  
  let message = `${phaseText} — ${stageText}`;
  
  if (agent) {
    message += ` (${agent})`;
  }
  
  if (round) {
    message += ` • Round ${round}`;
  }
  
  if (totalAgents && currentAgent) {
    const progress = Math.round((currentAgent / totalAgents) * 100);
    message += ` • ${currentAgent}/${totalAgents} agents • ${progress}%`;
  }
  
  return message;
}

// Resolve the consensus.md path for a build step.
// If planRunId is given → reads from the run directory.
// Otherwise falls back to the current output/plan/consensus.md.
async function resolvePlan(dir, planRunId, fallbackRelPath) {
  if (planRunId) {
    const runPath = `output/runs/${planRunId}/plan/consensus.md`;
    const content = await readProjectFile(dir, `.swarm/${runPath}`);
    if (!content) {
      return {
        error:
          `No consensus.md found for plan run "${planRunId}". ` +
          "Use swarm_status to list available plan runs.",
      };
    }
    return { content, resolvedPath: `.swarm/${runPath}` };
  }
  const content = await readProjectFile(dir, `.swarm/${fallbackRelPath}`);
  if (!content) {
    return {
      error:
        `Consensus plan not found at .swarm/${fallbackRelPath}. ` +
        "Run Swarm - Plan first, or specify a planRunId.",
    };
  }
  return { content, resolvedPath: `.swarm/${fallbackRelPath}` };
}

// ---------------------------------------------------------------------------
// Helpers — status & resume
// ---------------------------------------------------------------------------

// Read every meta.json under .swarm/output/runs/ and return an array of
// { runId, phase, ...metaFields } objects sorted newest-first.
// Directories that have no meta.json (e.g. interrupted mid-write) are skipped.
async function readAllRunMetas(projectDir) {
  const runsRoot = join(projectDir, ".swarm/output/runs");
  const results = [];

  let runDirs;
  try {
    runDirs = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return results; // no runs directory yet
  }

  for (const runEntry of runDirs) {
    if (!runEntry.isDirectory()) continue;
    const runId = runEntry.name;
    const runPath = join(runsRoot, runId);

    // Each runId can have phase subdirectories: plan/, build/, review/
    let phaseDirs;
    try {
      phaseDirs = await readdir(runPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const phaseEntry of phaseDirs) {
      if (!phaseEntry.isDirectory()) continue;
      const metaPath = join(runPath, phaseEntry.name, "meta.json");
      try {
        const raw = await readFile(metaPath, "utf8");
        const meta = JSON.parse(raw);
        results.push({ runId, ...meta });
      } catch {
        // meta.json missing or corrupt — include a stub so the run is visible
        results.push({
          runId,
          phase: phaseEntry.name,
          outcome: "unknown",
          startedAt: null,
        });
      }
    }
  }

  // Sort newest-first by startedAt, falling back to runId (which is a timestamp string)
  results.sort((a, b) => {
    const ta = a.startedAt ?? a.runId;
    const tb = b.startedAt ?? b.runId;
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });

  return results;
}

// List the files that actually exist inside a run/phase directory.
async function listRunFiles(projectDir, runId, phase) {
  const phaseDir = join(projectDir, ".swarm/output/runs", runId, phase);
  try {
    const entries = await readdir(phaseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name !== "meta.json")
      .map((e) => `.swarm/output/runs/${runId}/${phase}/${e.name}`);
  } catch {
    return [];
  }
}

// Extract the compressed context from the last completed round in a
// debate_log.md. Returns null if nothing can be found.
//
// The log format written by swarm_debate is:
//   ## Round N
//   ...
//   ### Phase 3 — Compressed Context
//   <compressed text>
//   ### Result
//   ...
function extractLastCompressedContext(logContent) {
  if (!logContent) return null;

  // Find all "### Phase 3 — Compressed Context" blocks
  const re = /###\s+Phase 3[^\n]*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/gi;
  let lastMatch = null;
  let m;
  while ((m = re.exec(logContent)) !== null) {
    lastMatch = m[1].trim();
  }
  return lastMatch || null;
}

// Extract the brief from the first round entry in a debate_log.md.
// The debate_log does not store the brief directly, so we fall back to the
// consensus.md file (which includes "## Project Brief").
function extractBriefFromConsensus(consensusContent) {
  if (!consensusContent) return null;
  const m = consensusContent.match(
    /##\s+Project Brief\s*\n([\s\S]*?)(?=\n##\s|$)/i,
  );
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Helpers — context compression
//
// After each debate round, instead of passing the raw full text of every
// agent's output to the next round (which blows up context), we run a
// compression step: a single LLM call that distills what each agent said,
// what they voted, and what specific changes they requested.
//
// The compression prompt is read from the "## Compress Prompt" section in
// plan.md so it is user-editable. If that section is absent, a built-in
// default is used.
//
// Template variables available in the compress prompt:
//   {{round}}           — round number just completed
//   {{agent_summaries}} — one block per agent: name, self-vote, full output
//   {{cross_votes}}     — JSON of crossVotes
// ---------------------------------------------------------------------------

const DEFAULT_COMPRESS_PROMPT = `\
You are a debate summariser. A multi-agent planning debate just completed round {{round}}.
Below are each agent's output and how they voted on each other.

{{agent_summaries}}

Cross-review votes:
{{cross_votes}}

Write a concise summary (aim for under 400 words total) that captures:
1. What each agent proposed (2-3 sentences each)
2. What each agent objected to or asked to change (be specific — quote the exact requirement)
3. The key open questions that must be resolved in the next round
4. What all agents agreed on (do not repeat these in the next round)

Format:
### Agent Summaries
<one paragraph per agent>

### Revision Requests
<bullet list of exact changes requested, labelled by which agent asked for them>

### Open Questions
<bullet list>

### Agreed Points (skip in next round)
<bullet list>
`;

async function compressContext(
  client,
  dir,
  round,
  agents,
  agentOutputs,
  selfVotes,
  crossVotes,
  compressTemplate,
) {
  const template = compressTemplate || DEFAULT_COMPRESS_PROMPT;

  const agentSummaries = agents
    .map(
      (a) =>
        `=== ${a.name} (self-vote: ${selfVotes[a.name]}) ===\n` +
        (agentOutputs[a.name] ?? "(no output)"),
    )
    .join("\n\n");

  const prompt = fillTemplate(template, {
    round: String(round),
    agent_summaries: agentSummaries,
    cross_votes: JSON.stringify(crossVotes, null, 2),
  });

  try {
    const compressed = await runSession(
      client,
      dir,
      `Swarm Compress — Round ${round}`,
      // Neutral system prompt — the compression step is orchestrator-level,
      // not tied to any specific agent's perspective.
      "You are a neutral debate summariser. Be concise and specific.",
      prompt,
      // Use the orchestrator's model for compression (don't pass agent model)
      null,
    );
    return compressed.trim();
  } catch (err) {
    // Compression is best-effort. If it fails, fall back to a minimal
    // hand-crafted summary so the debate can continue.
    console.error(
      `[swarm_debate] Compression failed (round ${round}): ${err.message}`,
    );
    return agents
      .map(
        (a) =>
          `${a.name} voted ${selfVotes[a.name]}.\n` +
          // Keep only the last 500 chars of each output as a fallback
          (agentOutputs[a.name] ?? "").slice(-500),
      )
      .join("\n\n---\n\n");
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const server = async (input) => {
  const { client } = input;

  return {
    // -----------------------------------------------------------------------
    // Register the three Swarm agents and the init agent so they appear in
    // the OpenCode agent picker alongside built-in agents like "build"/"plan".
    //
    // We deliberately do NOT set a model on any of these agents.
    // Whatever model the user has selected in the OpenCode UI becomes the
    // Orchestrator/Judge for that mode. The user is in control.
    //
    // The orchestrator system prompt is injected at runtime from the
    // ## Orchestrator section of the relevant mode file via the
    // experimental.chat.system.transform hook below.
    //
    // Commands are also registered here so /swarm_init works out of the box
    // without the user needing to edit config.json.
    // -----------------------------------------------------------------------
    config: async (config) => {
      config.agent = config.agent ?? {};
      config.command = config.command ?? {};

      // -- 1-swarm-plan -----------------------------------------------------
      config.agent["1-swarm-plan"] = {
        mode: "primary",
        description: "Multi-agent debate → consensus.md (Planning ONLY)",
        maxSteps: 40,
        permission: { edit: "deny", bash: "deny" }, // PLAN phase doesn't edit files
        prompt:
          "You are the Swarm Plan Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "IMPORTANT: You are ONLY for planning. Do NOT write code or edit files. " +
          "When the user describes a project, run the debate loop: " +
          "call swarm_debate with round=1 and the user's message as brief. " +
          "After each call check unanimous. If false, call swarm_debate again " +
          "with round+1, the returned context, and the returned runId. " +
          "If true, report that consensus.md has been written and show the runId. " +
          "If escalate is true, summarise the disagreements and ask the user to decide. " +
          "During processing, agents are working in background sessions. " +
          "You can say 'Agents are processing...' and show progress updates.",
        // Spread user overrides on top so config.json can still pin a model
        // or change any field without touching this file.
        ...config.agent["1-swarm-plan"],
      };

      // -- 2-swarm-build ----------------------------------------------------
      config.agent["2-swarm-build"] = {
        mode: "primary",
        description: "Implements a consensus plan step by step (Writes code)",
        maxSteps: 60,
        permission: { edit: "allow", bash: "allow" }, // BUILD phase writes files
        prompt:
          "You are the Swarm Build Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "IMPORTANT: You are ONLY for implementation. You write code and edit files. " +
          "If the user specified a plan run ID (e.g. 'build from plan run 2025-…'), " +
          "use that as planRunId in every swarm_build_run call. " +
          "Otherwise call swarm_status with phase='plan' first, show the user the available " +
          "consensus plans, and ask which one to build — then use its runId as planRunId. " +
          "Read the chosen consensus.md, break it into logical implementation steps, " +
          "and call swarm_build_run once per step passing planSection (the ## heading " +
          "in consensus.md that is most relevant to the step) to keep context small. " +
          "Pass the same runId to every swarm_build_run call so all steps share one run. " +
          "After all steps, summarise what was built. " +
          "During processing, the builder agent works in background. " +
          "You can say 'Builder is implementing step X...' and show progress.",
        ...config.agent["2-swarm-build"],
      };

      // -- 3-swarm-review ---------------------------------------------------
      config.agent["3-swarm-review"] = {
        mode: "primary",
        description: "Reviews implementation against consensus.md (Read-only)",
        maxSteps: 10,
        permission: { edit: "deny", bash: "deny" }, // REVIEW phase doesn't edit
        prompt:
          "You are the Swarm Review Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "IMPORTANT: You are ONLY for review. Do NOT write code or edit files. " +
          "Call swarm_review_run to compare the implementation against the " +
          "approved plan. Present the compliance matrix and verdict clearly. " +
          "During processing, the reviewer agent works in background. " +
          "You can say 'Reviewer is analyzing implementation...' and show status.",
        ...config.agent["3-swarm-review"],
      };

      // -- swarm-init (lightweight, only used by the /swarm_init command) ---
      // -- /swarm_init command ----------------------------------------------
      // Runs as a subtask inside whatever agent/mode is currently active.
      if (!config.command["swarm_init"]) {
        config.command["swarm_init"] = {
          description:
            "Set up .swarm/ in this project (copies the default template)",
          subtask: true,
          template:
            "Call swarm_init to copy the default .swarm/ template into this " +
            "project, then tell the user what was created and how to get started.",
        };
      }

      // -- /swarm_status command --------------------------------------------
      // Runs as a subtask inside whatever agent/mode is currently active.
      // No agent switch — just calls the tool and prints results inline.
      if (!config.command["swarm_status"]) {
        config.command["swarm_status"] = {
          description: "Show status of all past swarm runs in this project",
          subtask: true,
          template:
            "Call swarm_status to list all past swarm runs in this project " +
            "and present the results clearly. " +
            "If a runId was provided by the user, pass it to show detail for that run only: {{input}}",
        };
      }

      // -- /swarm_resume command --------------------------------------------
      // Runs as a subtask — resumes the debate inline without mode switching.
      if (!config.command["swarm_resume"]) {
        config.command["swarm_resume"] = {
          description:
            "Resume an interrupted Swarm Plan debate from its last completed round",
          subtask: true,
          template:
            "Call swarm_resume with this runId to continue the interrupted debate: {{input}} " +
            "If no runId was given, first call swarm_status to list runs with outcome " +
            "in_progress, then ask the user which one to resume.",
        };
      }

      // -- /swarm_build_select command --------------------------------------
      // Subtask that lists consensus-reached plan runs and tells the user
      // how to start a build from a specific one.
      if (!config.command["swarm_build_select"]) {
        config.command["swarm_build_select"] = {
          description:
            "List available consensus plans and switch to Swarm - Build with a chosen one",
          subtask: true,
          template:
            "Call swarm_status with phase='plan' to list all plan runs. " +
            "Show only the ones with outcome='consensus', including their runId and brief. " +
            "Tell the user: to build from a specific plan, switch to the '2-swarm-build' agent " +
            "and say 'build from plan run <runId>'. " +
            "If the user already specified a runId ({{input}}), confirm that run exists " +
            "and has outcome=consensus, then say they can switch to 2-swarm-build now.",
        };
      }

      // -- /swarm_status_live command ---------------------------------------
      if (!config.command["swarm_status_live"]) {
        config.command["swarm_status_live"] = {
          description: "Show live status of currently running swarm agents",
          subtask: true,
          template:
            "Check the current status of swarm operations and display it clearly. " +
            "Read .swarm/output/current_status.json and format the information.",
        };
      }
    },

    // -----------------------------------------------------------------------
    // Inject the ## Orchestrator section from the relevant mode file into the
    // orchestrator's system prompt at session start.
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      const systemText = output.system.join("\n");

      if (
        !systemText.includes("Swarm") ||
        !systemText.includes("Orchestrator")
      ) {
        return;
      }

      let modeFile = null;
      if (systemText.includes("Swarm Plan Orchestrator"))
        modeFile = ".swarm/plan.md";
      else if (systemText.includes("Swarm Build Orchestrator"))
        modeFile = ".swarm/build.md";
      else if (systemText.includes("Swarm Review Orchestrator"))
        modeFile = ".swarm/review.md";

      if (!modeFile) return;

      let projectDir = null;
      try {
        const proj = await client.project.current({});
        projectDir = proj.data?.directory ?? null;
      } catch {
        return;
      }

      if (!projectDir) return;

      const modeContent = await readProjectFile(projectDir, modeFile);
      if (!modeContent) return;

      const orchestratorSection = extractSection(modeContent, "Orchestrator");
      if (!orchestratorSection) return;

      output.system.push(
        `\n\n---\n## Orchestrator Instructions (from ${modeFile})\n\n${orchestratorSection}`,
      );
    },

    // -----------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------
    tool: {
      // ---------------------------------------------------------------------
      // swarm_init
      // ---------------------------------------------------------------------
      swarm_init: tool({
        description:
          "Copy the default .swarm/ template into this project. " +
          "Safe — will not overwrite files that already exist unless force=true.",
        args: {
          force: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, overwrite existing files. Default false — skip files that already exist.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          const force = args.force ?? false;
          ctx.metadata({ title: "Swarm Init" });

          try {
            await stat(TEMPLATE_DIR);
          } catch {
            return JSON.stringify({
              error:
                `Template directory not found at ${TEMPLATE_DIR}. ` +
                "Re-check your opencode swarm plugin installation.",
            });
          }

          let templateFiles;
          try {
            templateFiles = await collectFiles(TEMPLATE_DIR);
          } catch (err) {
            return JSON.stringify({
              error: `Failed to read template: ${err.message}`,
            });
          }

          const created = [];
          const skipped = [];
          const errors = [];

          for (const relFile of templateFiles) {
            const dest = join(dir, ".swarm", relFile);
            const src = join(TEMPLATE_DIR, relFile);

            let exists = false;
            try {
              await stat(dest);
              exists = true;
            } catch {
              // does not exist — good
            }

            if (exists && !force) {
              skipped.push(`.swarm/${relFile}`);
              continue;
            }

            try {
              await mkdir(dirname(dest), { recursive: true });
              await cp(src, dest, { force: true });
              created.push(`.swarm/${relFile}`);
            } catch (err) {
              errors.push({ file: `.swarm/${relFile}`, error: err.message });
            }
          }

          // Ensure runtime output directories exist (not in template).
          for (const outDir of [
            join(dir, ".swarm/output/plan"),
            join(dir, ".swarm/output/build"),
            join(dir, ".swarm/output/review"),
            join(dir, ".swarm/output/runs"),
          ]) {
            try {
              await mkdir(outDir, { recursive: true });
            } catch {
              /* ignore */
            }
          }

          const lines = ["Swarm init complete.\n"];
          if (created.length > 0) {
            lines.push(`Created (${created.length}):`);
            created.forEach((f) => lines.push(`  + ${f}`));
          }
          if (skipped.length > 0) {
            lines.push(`\nSkipped — already exist (${skipped.length}):`);
            skipped.forEach((f) => lines.push(`  = ${f}`));
            lines.push("\nRun with force=true to overwrite.");
          }
          if (errors.length > 0) {
            lines.push(`\nErrors (${errors.length}):`);
            errors.forEach(({ file, error }) =>
              lines.push(`  ! ${file}: ${error}`),
            );
          }
          lines.push(
            "\nNext steps:",
            '  1. Switch to the "Swarm - Plan" agent',
            "  2. Describe your project",
            "  3. The agents in .swarm/plan.md will debate until unanimous",
            "  4. Review .swarm/output/plan/consensus.md",
            '  5. Switch to "Swarm - Build" to implement the plan',
          );

          return JSON.stringify({
            created,
            skipped,
            errors,
            summary: lines.join("\n"),
          });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_debate
      //
      // Runs one complete round of the planning debate.
      //
      // Phase 1 — Produce
      //   Every agent receives the Produce Prompt and writes their plan.
      //   Each agent self-votes (VOTE: APPROVE / VOTE: REVISE). Counted.
      //
      // Phase 2 — Cross-Review
      //   Every agent reads every other agent's output and votes. Counted.
      //
      // Phase 3 — Compress
      //   A single LLM call distils all outputs + votes into a compact
      //   summary that becomes the {{context}} for the next round. This
      //   keeps the context window from growing linearly with rounds.
      //
      // Run history:
      //   All output is written to .swarm/output/runs/<runId>/plan/ and
      //   also copied to .swarm/output/plan/ (current).
      //   runId is generated on round 1 and returned so the orchestrator
      //   can pass it back on subsequent rounds.
      // ---------------------------------------------------------------------
      swarm_debate: tool({
        description:
          "Run one round of the multi-agent planning debate. " +
          "Phase 1: each agent produces a plan and self-votes. " +
          "Phase 2: each agent cross-reviews all others. " +
          "Phase 3: outputs are compressed into a compact context for the next round. " +
          "Unanimous requires every vote (both phases) to be APPROVE. " +
          "On round 1 omit runId — a new one is generated. " +
          "Pass the returned runId and context back on every subsequent call.",
        args: {
          round: tool.schema
            .number()
            .describe("Current round number. Start at 1, add 1 each call."),
          brief: tool.schema
            .string()
            .describe("The project brief the user gave you. Same every round."),
          context: tool.schema
            .string()
            .optional()
            .describe(
              "Compressed context returned by the previous round. Omit on round 1.",
            ),
          runId: tool.schema
            .string()
            .optional()
            .describe(
              "Run ID returned by round 1. Pass it back on all subsequent rounds " +
                "so all rounds belong to the same run directory.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          ctx.metadata({ title: `Swarm Plan — Round ${args.round}` });

          // Clear any previous status
          await clearStatus(dir);
          
          let runId;
          try {
            // -- Resolve or create run ID ------------------------------------
            runId = args.runId ?? makeRunId();

          // -- Read mode file -----------------------------------------------
          const modeContent = await readProjectFile(dir, ".swarm/plan.md");
          if (!modeContent) {
            return JSON.stringify({
              error:
                "No .swarm/plan.md found. Run /swarm_init first to set up this project.",
            });
          }

          const fm = parseFrontmatter(modeContent);
          const maxRounds = fm.max_rounds ?? 5;
          const rawAgents = Array.isArray(fm.agents) ? fm.agents : [];

          if (rawAgents.length === 0) {
            return JSON.stringify({
              error:
                "plan.md frontmatter has no agents listed. " +
                "Add them like:\n  agents:\n    - backend_architect\n    - frontend_planner",
            });
          }

          // -- Escalate if max rounds exceeded ------------------------------
          if (args.round > maxRounds) {
            // Update meta for this run to record the escalation
            const runDir = await ensureRunDir(dir, runId, "plan");
            await writeMeta(runDir, {
              outcome: "escalated",
              roundsCompleted: args.round - 1,
              updatedAt: new Date().toISOString(),
            });
            return JSON.stringify({
              runId,
              unanimous: false,
              escalate: true,
              message:
                `Reached the maximum of ${maxRounds} rounds without unanimous agreement. ` +
                `Review .swarm/output/runs/${runId}/plan/debate_log.md and decide.`,
            });
          }

          // -- Validate required sections -----------------------------------
          const produceTemplate = extractSection(modeContent, "Produce Prompt");
          const crossReviewTemplate = extractSection(
            modeContent,
            "Cross-Review Prompt",
          );
          // compressTemplate is optional — falls back to built-in default
          const compressTemplate =
            extractSection(modeContent, "Compress Prompt") || null;

          if (!produceTemplate) {
            return JSON.stringify({
              error: "plan.md is missing a '## Produce Prompt' section.",
            });
          }
          if (!crossReviewTemplate) {
            return JSON.stringify({
              error: "plan.md is missing a '## Cross-Review Prompt' section.",
            });
          }

          // -- Load agents --------------------------------------------------
          const agents = [];
          for (const rawName of rawAgents) {
            const agent = await loadAgent(dir, String(rawName));
            if (!agent) {
              console.error(
                `[swarm_debate] Could not load agent: "${rawName}" ` +
                  `(tried .swarm/${resolveAgentPath(String(rawName))})`,
              );
              continue;
            }
            agents.push(agent);
          }

          if (agents.length === 0) {
            return JSON.stringify({
              error:
                "No agent files could be loaded. " +
                "Check the names listed under agents: in plan.md match files in .swarm/agents/",
            });
          }

          // -- Ensure run directory -----------------------------------------
          const runDir = await ensureRunDir(dir, runId, "plan");

          // Update status to show planning started
          await updateStatus(dir, {
            phase: 'plan',
            stage: 'starting',
            status: 'processing',
            runId,
            round: args.round,
            totalAgents: agents.length,
            message: createProgressMessage('plan', 'starting', null, args.round, agents.length, 0),
          });

          // Write/update meta at the start of the round
          if (args.round === 1) {
            await writeMeta(runDir, {
              runId,
              phase: "plan",
              brief: args.brief,
              agents: agents.map((a) => a.name),
              maxRounds,
              startedAt: new Date().toISOString(),
              outcome: "in_progress",
              roundsCompleted: 0,
            });
          }

          // -----------------------------------------------------------------
          // Phase 1 — Produce
          // -----------------------------------------------------------------
          const agentOutputs = {}; // agent.name → full output text
          const selfVotes = {}; // agent.name → "APPROVE" | "REVISE"

          for (let i = 0; i < agents.length; i++) {
            const agent = agents[i];
            
            // Update status to show which agent is working
            await updateStatus(dir, {
              phase: 'plan',
              stage: 'produce',
              status: 'processing',
              runId,
              round: args.round,
              agent: agent.name,
              currentAgent: i + 1,
              totalAgents: agents.length,
              message: createProgressMessage('plan', 'produce', agent.name, args.round, agents.length, i + 1),
            });

            const prompt = fillTemplate(produceTemplate, {
              round: String(args.round),
              brief: args.brief,
              context:
                args.context ?? "This is the first round — no prior context.",
            });

            try {
              const output = await runSession(
                client,
                dir,
                `Swarm Plan R${args.round} — ${agent.name}`,
                agent.systemPrompt,
                prompt,
                agent.model, // Pass agent's model
              );
              agentOutputs[agent.name] = output;
              selfVotes[agent.name] = detectVote(output);
            } catch (err) {
              console.error(
                `[swarm_debate] Phase 1 error (${agent.name}): ${err.message}`,
              );
              agentOutputs[agent.name] = `[ERROR: ${err.message}]`;
              selfVotes[agent.name] = "REVISE";
            }
          }

          // -----------------------------------------------------------------
          // Phase 2 — Cross-Review
          // crossVotes[reviewer.name][reviewed.name] = "APPROVE" | "REVISE"
          // -----------------------------------------------------------------
          const crossVotes = {};

          // Update status for cross-review phase
          await updateStatus(dir, {
            phase: 'plan',
            stage: 'cross_review',
            status: 'processing',
            runId,
            round: args.round,
            message: createProgressMessage('plan', 'cross_review', null, args.round, agents.length, 0),
          });

          for (const reviewer of agents) {
            crossVotes[reviewer.name] = {};

            for (const reviewed of agents) {
              if (reviewer.name === reviewed.name) continue;

              const prompt = fillTemplate(crossReviewTemplate, {
                agent_name: reviewed.name,
                agent_output: agentOutputs[reviewed.name] ?? "(no output)",
              });

              try {
                const reviewText = await runSession(
                  client,
                  dir,
                  `Swarm Cross-Review R${args.round} — ${reviewer.name} → ${reviewed.name}`,
                  reviewer.systemPrompt,
                  prompt,
                  reviewer.model, // Pass reviewer's model
                );
                crossVotes[reviewer.name][reviewed.name] =
                  detectVote(reviewText);
              } catch (err) {
                console.error(
                  `[swarm_debate] Phase 2 error (${reviewer.name} → ${reviewed.name}): ${err.message}`,
                );
                crossVotes[reviewer.name][reviewed.name] = "REVISE";
              }
            }
          }

          // -----------------------------------------------------------------
          // Tally — unanimous requires EVERY vote from BOTH phases to be APPROVE
          // -----------------------------------------------------------------
          const allSelfVotes = Object.values(selfVotes);
          const allCrossVotes = Object.values(crossVotes).flatMap((v) =>
            Object.values(v),
          );
          const allVotes = [...allSelfVotes, ...allCrossVotes];
          const unanimous =
            allVotes.length > 0 && allVotes.every((v) => v === "APPROVE");

          // -----------------------------------------------------------------
          // Phase 3 — Compress
          // Distil all outputs + votes into a compact context for the next
          // round. This is the key token-saving step: instead of passing
          // potentially thousands of tokens of raw agent prose, we pass a
          // structured ~400-word summary of what changed and what's open.
          // We always compress, even on the final round, so the log is clean.
          // -----------------------------------------------------------------
          
          // Update status for compression phase
          await updateStatus(dir, {
            phase: 'plan',
            stage: 'compress',
            status: 'processing',
            runId,
            round: args.round,
            message: createProgressMessage('plan', 'compress', null, args.round, agents.length, 0),
          });
          
          const compressedContext = await compressContext(
            client,
            dir,
            args.round,
            agents,
            agentOutputs,
            selfVotes,
            crossVotes,
            compressTemplate,
          );

          // -----------------------------------------------------------------
          // Write to run directory
          // -----------------------------------------------------------------
          const logEntry = [
            `## Round ${args.round}`,
            ``,
            `### Phase 1 — Agent Outputs & Self-Votes`,
            ``,
            ...agents.map(
              (a) =>
                `#### ${a.name} — self-vote: **${selfVotes[a.name]}**\n\n` +
                (agentOutputs[a.name] ?? "(no output)") +
                `\n`,
            ),
            `### Phase 2 — Cross-Review Votes`,
            ``,
            "```json",
            JSON.stringify(crossVotes, null, 2),
            "```",
            ``,
            `### Phase 3 — Compressed Context`,
            ``,
            compressedContext,
            ``,
            `### Result`,
            ``,
            `Self-votes: ${JSON.stringify(selfVotes)}`,
            `All unanimous: **${unanimous}**`,
            ``,
          ].join("\n");

          const runLogPath = join(runDir, "debate_log.md");
          await appendLog(runLogPath, "Debate Log", logEntry);

          // Consensus — written to run dir when unanimous
          const consensusRunPath = join(runDir, "consensus.md");
          if (unanimous) {
            const lines = [
              `# Consensus Plan`,
              ``,
              `> Run: ${runId}`,
              `> Unanimous agreement reached after ${args.round} round(s).`,
              ``,
              `## Project Brief`,
              ``,
              args.brief,
              ``,
            ];
            for (const agent of agents) {
              lines.push(
                `## ${agent.name}`,
                ``,
                agentOutputs[agent.name] ?? "",
                ``,
              );
            }
            await writeFile(consensusRunPath, lines.join("\n"), "utf8");
          }

          // Update meta
          await writeMeta(runDir, {
            roundsCompleted: args.round,
            outcome: unanimous ? "consensus" : "in_progress",
            selfVotes,
            updatedAt: new Date().toISOString(),
          });

          // -----------------------------------------------------------------
          // Publish to "current" paths so orchestrator references stay stable
          // -----------------------------------------------------------------
          await publishCurrent(runLogPath, dir, "output/plan/debate_log.md");
          if (unanimous) {
            await publishCurrent(
              consensusRunPath,
              dir,
              "output/plan/consensus.md",
            );
          }

          // Update final status
          if (unanimous) {
            await updateStatus(dir, {
              phase: 'plan',
              stage: 'complete',
              status: 'completed',
              runId,
              round: args.round,
              result: 'consensus',
              message: `✅ Planning complete! Consensus reached after round ${args.round}.`,
            });
          } else {
            await updateStatus(dir, {
              phase: 'plan',
              stage: 'complete',
              status: 'completed',
              runId,
              round: args.round,
              result: 'needs_next_round',
              message: `🔄 Round ${args.round} complete. Ready for next round.`,
            });
          }

          return JSON.stringify({
            runId,
            round: args.round,
            unanimous,
            selfVotes,
            crossVotes,
            // Return the compressed context, not raw outputs — far smaller
            context: compressedContext,
            message: unanimous
              ? `All agents agreed (self + cross votes) after round ${args.round}. ` +
                `Run ID: ${runId}. ` +
                `Consensus written to .swarm/output/runs/${runId}/plan/consensus.md ` +
                `and .swarm/output/plan/consensus.md`
              : `Round ${args.round} complete — not unanimous. ` +
                `Self-votes: ${JSON.stringify(selfVotes)}. ` +
                `Call swarm_debate with round=${args.round + 1}, ` +
                `pass the returned context and runId="${runId}".`,
          });
        } catch (err) {
          // Update status with error
          await updateStatus(dir, {
            phase: 'plan',
            stage: 'error',
            status: 'error',
            runId: runId || 'unknown',
            error: err.message,
            message: `❌ Planning failed: ${err.message}`,
          });
          
          console.error(`[swarm_debate] Error: ${err.message}`, err);
          return JSON.stringify({
            error: `Swarm debate failed: ${err.message}`,
            runId: runId || null,
          });
        }
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_build_run
      //
      // Sends one implementation step to the Builder agent. All steps in a
      // single build session share a runId so they land in the same run dir.
      // On the first step omit runId — a new one is generated. Pass the
      // returned runId to every subsequent swarm_build_run call.
      // ---------------------------------------------------------------------
      swarm_build_run: tool({
        description:
          "Run one implementation step using the Builder agent from .swarm/build.md. " +
          "On the first step omit runId — a new one is generated. " +
          "Pass the returned runId back on all subsequent steps so they share one run directory. " +
          "Use planRunId to build from a specific plan run instead of the current consensus.md. " +
          "Use planSection to inject only the relevant ## heading from the plan, reducing context size.",
        args: {
          step: tool.schema
            .string()
            .describe(
              "What to implement in this step, taken from the consensus plan.",
            ),
          runId: tool.schema
            .string()
            .optional()
            .describe(
              "Run ID from the first swarm_build_run call. Omit on the very first step.",
            ),
          planRunId: tool.schema
            .string()
            .optional()
            .describe(
              "Plan run ID to build from (e.g. '2025-04-18_15-32-01'). " +
                "If omitted, uses the current .swarm/output/plan/consensus.md. " +
                "Get available IDs from swarm_status.",
            ),
          planSection: tool.schema
            .string()
            .optional()
            .describe(
              "Name of a ## heading in the consensus plan to inject for this step (e.g. 'Backend Architect'). " +
                "When set, only that section is sent to the builder instead of the full plan — " +
                "significantly reduces context size. Omit to send the full plan.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          const runId = args.runId ?? makeRunId();
          ctx.metadata({ title: `Swarm Build — ${args.step.slice(0, 60)}` });

          // Clear any previous status
          await clearStatus(dir);

          // -- Read mode file -----------------------------------------------
          const modeContent = await readProjectFile(dir, ".swarm/build.md");
          if (!modeContent) {
            return JSON.stringify({
              error: "No .swarm/build.md found. Run /swarm_init first.",
            });
          }

          const fm = parseFrontmatter(modeContent);
          const agentRaw = fm.agent ?? "builder";
          const planFile = fm.plan_file ?? "output/plan/consensus.md";

          const stepTemplate = extractSection(modeContent, "Step Prompt");
          if (!stepTemplate) {
            return JSON.stringify({
              error: "build.md is missing a '## Step Prompt' section.",
            });
          }

          // -- Load agent ---------------------------------------------------
          const agent = await loadAgent(dir, String(agentRaw));
          if (!agent) {
            return JSON.stringify({
              error:
                `Agent not found: "${agentRaw}" ` +
                `(tried .swarm/${resolveAgentPath(String(agentRaw))})`,
            });
          }

          // -- Load plan (from specific run or current) ----------------------
          const planResult = await resolvePlan(
            dir,
            args.planRunId ?? null,
            planFile,
          );
          if (planResult.error) {
            return JSON.stringify({ error: planResult.error });
          }
          const fullPlan = planResult.content;

          // -- Extract only the relevant section if planSection is given ----
          // This is the primary context-reduction mechanism for build steps:
          // instead of injecting the full multi-agent consensus (potentially
          // thousands of tokens), we inject only the one ## section that
          // is relevant to the current step.
          let plan = fullPlan;
          let sectionNote = "";
          if (args.planSection) {
            const extracted = extractPlanSection(fullPlan, args.planSection);
            if (extracted) {
              plan = extracted;
              sectionNote = ` (section: ${args.planSection})`;
            } else {
              // Section not found — list available sections so orchestrator
              // can correct the name on the next call.
              const available = listPlanSections(fullPlan);
              return JSON.stringify({
                error:
                  `Section "${args.planSection}" not found in the plan. ` +
                  `Available sections: ${available.join(", ")}`,
                availableSections: available,
              });
            }
          }

          // -- Update status for building ------------------------------------
          await updateStatus(dir, {
            phase: 'build',
            stage: 'building',
            status: 'processing',
            runId,
            step: args.step,
            agent: agent.name,
            message: createProgressMessage('build', 'building', agent.name, null, 1, 1),
          });

          // -- Run builder --------------------------------------------------
          const prompt = fillTemplate(stepTemplate, { plan, step: args.step });

          let output;
          try {
            output = await runSession(
              client,
              dir,
              `Swarm Build — ${args.step.slice(0, 50)}`,
              agent.systemPrompt,
              prompt,
              agent.model, // Pass builder's model
            );
          } catch (err) {
            // Update status with error
            await updateStatus(dir, {
              phase: 'build',
              stage: 'building',
              status: 'error',
              runId,
              step: args.step,
              agent: agent.name,
              error: err.message,
              message: `❌ Build failed: ${err.message}`,
            });
            return JSON.stringify({ error: err.message });
          }

          // -- Write to run directory ---------------------------------------
          const runDir = await ensureRunDir(dir, runId, "build");
          const logEntry = `## Step: ${args.step}${sectionNote}\n\n${output}`;
          const runLogPath = join(runDir, "build_log.md");
          await appendLog(runLogPath, "Build Log", logEntry);

          // Update meta
          const metaPath = join(runDir, "meta.json");
          let meta = {};
          try {
            meta = JSON.parse(await readFile(metaPath, "utf8"));
          } catch {
            /**/
          }
          const steps = Array.isArray(meta.steps) ? meta.steps : [];
          steps.push({
            step: args.step,
            completedAt: new Date().toISOString(),
          });
          await writeMeta(runDir, {
            runId,
            phase: "build",
            planRunId: args.planRunId ?? null,
            startedAt: meta.startedAt ?? new Date().toISOString(),
            steps,
            updatedAt: new Date().toISOString(),
          });

          // -- Publish to current -------------------------------------------
          await publishCurrent(runLogPath, dir, "output/build/build_log.md");

          // Update status for completion
          await updateStatus(dir, {
            phase: 'build',
            stage: 'complete',
            status: 'completed',
            runId,
            step: args.step,
            agent: agent.name,
            message: `✅ Build step completed: ${args.step}`,
          });

          // Surface available sections so orchestrator knows what to pass
          // on subsequent steps without reading the full plan itself.
          const availableSections = listPlanSections(fullPlan);

          return JSON.stringify({
            runId,
            step: args.step,
            planSection: args.planSection ?? null,
            planRunId: args.planRunId ?? null,
            availableSections,
            output,
          });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_review_run
      //
      // Runs the Reviewer agent and writes a structured report.
      // A new runId is generated for each review run.
      // ---------------------------------------------------------------------
      swarm_review_run: tool({
        description:
          "Review the implementation against consensus.md using the agent from .swarm/review.md. " +
          "Each call creates a new timestamped run in .swarm/output/runs/.",
        args: {
          focus: tool.schema
            .string()
            .optional()
            .describe(
              "Optional: a specific area to focus on, e.g. 'auth', 'API contracts'. " +
                "Leave empty for a full review.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          const runId = makeRunId();
          ctx.metadata({ title: "Swarm Review" });

          // Clear any previous status
          await clearStatus(dir);

          // -- Read mode file -----------------------------------------------
          const modeContent = await readProjectFile(dir, ".swarm/review.md");
          if (!modeContent) {
            return JSON.stringify({
              error: "No .swarm/review.md found. Run /swarm_init first.",
            });
          }

          const fm = parseFrontmatter(modeContent);
          const agentRaw = fm.agent ?? "reviewer";
          const planFile = fm.plan_file ?? "output/plan/consensus.md";
          const reportFile = fm.report_file ?? "output/review/review_report.md";

          const reviewTemplate = extractSection(modeContent, "Review Prompt");
          if (!reviewTemplate) {
            return JSON.stringify({
              error: "review.md is missing a '## Review Prompt' section.",
            });
          }

          // -- Load agent ---------------------------------------------------
          const agent = await loadAgent(dir, String(agentRaw));
          if (!agent) {
            return JSON.stringify({
              error:
                `Agent not found: "${agentRaw}" ` +
                `(tried .swarm/${resolveAgentPath(String(agentRaw))})`,
            });
          }

          // -- Load plan ----------------------------------------------------
          const plan = await readProjectFile(dir, `.swarm/${planFile}`);
          if (!plan) {
            return JSON.stringify({
              error:
                `Consensus plan not found at .swarm/${planFile}. ` +
                "Run Swarm - Plan first.",
            });
          }

          // -- Update status for reviewing -----------------------------------
          const focusText =
            args.focus ?? "full review — cover everything in the plan";
          
          await updateStatus(dir, {
            phase: 'review',
            stage: 'reviewing',
            status: 'processing',
            runId,
            focus: focusText,
            agent: agent.name,
            message: createProgressMessage('review', 'reviewing', agent.name, null, 1, 1),
          });

          // -- Run reviewer -------------------------------------------------
          const prompt = fillTemplate(reviewTemplate, {
            plan,
            focus: focusText,
          });

          let output;
          try {
            output = await runSession(
              client,
              dir,
              "Swarm Review",
              agent.systemPrompt,
              prompt,
              agent.model, // Pass reviewer's model
            );
          } catch (err) {
            // Update status with error
            await updateStatus(dir, {
              phase: 'review',
              stage: 'reviewing',
              status: 'error',
              runId,
              focus: focusText,
              agent: agent.name,
              error: err.message,
              message: `❌ Review failed: ${err.message}`,
            });
            return JSON.stringify({ error: err.message });
          }

          // Detect verdict from output for meta
          let verdict = "unknown";
          if (/VERDICT:\s*PASS_WITH_WARNINGS/i.test(output))
            verdict = "PASS_WITH_WARNINGS";
          else if (/VERDICT:\s*PASS/i.test(output)) verdict = "PASS";
          else if (/VERDICT:\s*FAIL/i.test(output)) verdict = "FAIL";

          // -- Write to run directory ---------------------------------------
          const runDir = await ensureRunDir(dir, runId, "review");
          const reportContent = `# Review Report\n\n> Run: ${runId}\n> Focus: ${focusText}\n\n${output}`;
          const runReportPath = join(runDir, "review_report.md");
          await writeFile(runReportPath, reportContent, "utf8");

          await writeMeta(runDir, {
            runId,
            phase: "review",
            focus: focusText,
            verdict,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          // Update status for completion
          await updateStatus(dir, {
            phase: 'review',
            stage: 'complete',
            status: 'completed',
            runId,
            verdict,
            agent: agent.name,
            message: `✅ Review completed. Verdict: ${verdict}`,
          });

          // -- Publish to current -------------------------------------------
          await publishCurrent(runReportPath, dir, reportFile);

          return JSON.stringify({
            runId,
            verdict,
            output,
            reportPath: `.swarm/output/runs/${runId}/review/review_report.md`,
            currentPath: `.swarm/${reportFile}`,
          });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_status
      //
      // Lists every run recorded under .swarm/output/runs/ with its outcome,
      // round count, verdict, and the files produced. Accepts an optional
      // runId to show detail for a single run, and an optional phase filter.
      // ---------------------------------------------------------------------
      swarm_status: tool({
        description:
          "List all past swarm runs in this project. " +
          "Shows outcome, rounds, verdict, and files for every run. " +
          "Pass runId to inspect a single run in detail. " +
          "Pass phase ('plan'|'build'|'review') to filter.",
        args: {
          runId: tool.schema
            .string()
            .optional()
            .describe("Show detail for this specific run ID only."),
          phase: tool.schema
            .string()
            .optional()
            .describe(
              "Filter to a specific phase: 'plan', 'build', or 'review'.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          ctx.metadata({ title: "Swarm Status" });

          const allMetas = await readAllRunMetas(dir);

          if (allMetas.length === 0) {
            return JSON.stringify({
              runs: [],
              summary:
                "No swarm runs found in this project. " +
                "Run /swarm_init and then switch to Swarm - Plan to start.",
            });
          }

          // Filter by runId or phase if requested
          let filtered = allMetas;
          if (args.runId) {
            filtered = filtered.filter((m) => m.runId === args.runId);
            if (filtered.length === 0) {
              return JSON.stringify({
                error: `No run found with ID "${args.runId}".`,
                availableRunIds: [...new Set(allMetas.map((m) => m.runId))],
              });
            }
          }
          if (args.phase) {
            filtered = filtered.filter((m) => m.phase === args.phase);
          }

          // Enrich each meta entry with the list of files produced
          const enriched = await Promise.all(
            filtered.map(async (meta) => {
              const files = await listRunFiles(dir, meta.runId, meta.phase);
              return { ...meta, files };
            }),
          );

          // Build a human-readable summary table
          const lines = [`Swarm runs (${enriched.length} found):`, ""];

          // Group by runId for display
          const byRunId = {};
          for (const entry of enriched) {
            if (!byRunId[entry.runId]) byRunId[entry.runId] = [];
            byRunId[entry.runId].push(entry);
          }

          for (const [runId, phases] of Object.entries(byRunId)) {
            lines.push(`### Run: ${runId}`);
            for (const p of phases) {
              const outcomeIcon =
                p.outcome === "consensus"
                  ? "✅"
                  : p.outcome === "escalated"
                    ? "⚠️"
                    : p.outcome === "in_progress"
                      ? "🔄"
                      : p.outcome === "unknown"
                        ? "❓"
                        : p.verdict === "PASS"
                          ? "✅"
                          : p.verdict === "PASS_WITH_WARNINGS"
                            ? "⚠️"
                            : p.verdict === "FAIL"
                              ? "❌"
                              : "❓";

              lines.push(
                `  Phase: ${p.phase}  ${outcomeIcon} ${p.outcome ?? p.verdict ?? ""}`,
              );

              if (p.phase === "plan") {
                lines.push(`  Rounds completed: ${p.roundsCompleted ?? "?"}`);
                if (p.brief) {
                  const shortBrief =
                    p.brief.length > 80 ? p.brief.slice(0, 80) + "…" : p.brief;
                  lines.push(`  Brief: ${shortBrief}`);
                }
                if (p.agents) {
                  lines.push(`  Agents: ${p.agents.join(", ")}`);
                }
              }
              if (p.phase === "build") {
                const stepCount = Array.isArray(p.steps) ? p.steps.length : "?";
                lines.push(`  Steps completed: ${stepCount}`);
              }
              if (p.phase === "review") {
                lines.push(`  Verdict: ${p.verdict ?? "unknown"}`);
                if (p.focus) lines.push(`  Focus: ${p.focus}`);
              }

              lines.push(`  Started: ${p.startedAt ?? "unknown"}`);

              if (p.files && p.files.length > 0) {
                lines.push(`  Files:`);
                p.files.forEach((f) => lines.push(`    ${f}`));
              }
              lines.push("");
            }
          }

          return JSON.stringify({
            runs: enriched,
            summary: lines.join("\n"),
          });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_resume
      //
      // Resumes a plan debate that was interrupted (network error, token
      // limit, process killed, etc.).
      //
      // Strategy:
      //   1. Read meta.json for the given runId — get brief, roundsCompleted,
      //      agents, maxRounds, outcome.
      //   2. Guard against resuming a run that already finished.
      //   3. Read debate_log.md and extract the compressed context from the
      //      last completed round's "### Phase 3 — Compressed Context" block.
      //   4. Call swarm_debate in a loop starting from roundsCompleted+1,
      //      passing the runId and recovered context, until unanimous or
      //      maxRounds is exceeded.
      //
      // The tool runs to completion autonomously — the user gets the same
      // result as if the debate had never been interrupted.
      // ---------------------------------------------------------------------
      swarm_resume: tool({
        description:
          "Resume an interrupted Swarm Plan debate from where it stopped. " +
          "Reads the last completed round from the run's debate log and " +
          "continues the debate to completion. " +
          "Use swarm_status to find the runId of the interrupted run.",
        args: {
          runId: tool.schema
            .string()
            .describe(
              "The run ID of the interrupted plan debate to resume. " +
                "Find it with swarm_status.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          const { runId } = args;
          ctx.metadata({ title: `Swarm Resume — ${runId}` });

          // -- Read run meta ------------------------------------------------
          const runDir = join(dir, ".swarm/output/runs", runId, "plan");
          let meta;
          try {
            meta = JSON.parse(
              await readFile(join(runDir, "meta.json"), "utf8"),
            );
          } catch {
            return JSON.stringify({
              error:
                `No plan run found with ID "${runId}". ` +
                "Use swarm_status to list available runs.",
            });
          }

          // -- Guard: already finished --------------------------------------
          if (meta.outcome === "consensus") {
            return JSON.stringify({
              alreadyComplete: true,
              runId,
              message:
                `Run "${runId}" already reached consensus after ` +
                `${meta.roundsCompleted} round(s). ` +
                `Consensus is at .swarm/output/runs/${runId}/plan/consensus.md`,
            });
          }
          if (meta.outcome === "escalated") {
            return JSON.stringify({
              alreadyComplete: true,
              runId,
              message:
                `Run "${runId}" was already escalated after ` +
                `${meta.roundsCompleted} round(s) — human decision required. ` +
                `Review .swarm/output/runs/${runId}/plan/debate_log.md`,
            });
          }

          const roundsCompleted = meta.roundsCompleted ?? 0;
          const maxRounds = meta.maxRounds ?? 5;
          const brief = meta.brief;

          if (!brief) {
            return JSON.stringify({
              error:
                `Run "${runId}" meta.json is missing the "brief" field — ` +
                "cannot resume without knowing the original project brief.",
            });
          }

          // -- Recover context from last completed round --------------------
          const logContent = await readProjectFile(
            dir,
            `output/runs/${runId}/plan/debate_log.md`,
          );

          let recoveredContext = null;

          if (roundsCompleted > 0) {
            recoveredContext = extractLastCompressedContext(logContent);
            if (!recoveredContext) {
              // Fallback: if the compressed context block is missing (old log
              // format or truncated file), synthesise a minimal context note.
              recoveredContext =
                `Resuming from round ${roundsCompleted}. ` +
                "No compressed context was found in the debate log — " +
                "please re-examine the project brief and produce fresh plans.";
            }
          }

          // -- Validate mode file is still intact ---------------------------
          const modeContent = await readProjectFile(dir, ".swarm/plan.md");
          if (!modeContent) {
            return JSON.stringify({
              error:
                "No .swarm/plan.md found. " +
                "The mode configuration file is required to resume.",
            });
          }

          const fm = parseFrontmatter(modeContent);
          const rawAgents = Array.isArray(fm.agents) ? fm.agents : [];
          const compressTemplate =
            extractSection(modeContent, "Compress Prompt") || null;
          const produceTemplate = extractSection(modeContent, "Produce Prompt");
          const crossReviewTemplate = extractSection(
            modeContent,
            "Cross-Review Prompt",
          );

          if (!produceTemplate || !crossReviewTemplate) {
            return JSON.stringify({
              error:
                "plan.md is missing required sections " +
                "(## Produce Prompt and/or ## Cross-Review Prompt).",
            });
          }

          const agents = [];
          for (const rawName of rawAgents) {
            const agent = await loadAgent(dir, String(rawName));
            if (agent) agents.push(agent);
          }
          if (agents.length === 0) {
            return JSON.stringify({
              error: "No agent files could be loaded from plan.md.",
            });
          }

          // -- Resume loop --------------------------------------------------
          let currentRound = roundsCompleted + 1;
          let currentContext = recoveredContext;
          let finalResult = null;

          ctx.metadata({
            title: `Swarm Resume — ${runId} from round ${currentRound}`,
          });

          while (currentRound <= maxRounds) {
            ctx.metadata({
              title: `Swarm Resume — ${runId} R${currentRound}`,
            });

            // --- Phase 1: Produce ---
            const agentOutputs = {};
            const selfVotes = {};

            for (const agent of agents) {
              const prompt = fillTemplate(produceTemplate, {
                round: String(currentRound),
                brief,
                context:
                  currentContext ??
                  "This is the first round — no prior context.",
              });
              try {
                const output = await runSession(
                  client,
                  dir,
                  `Swarm Plan R${currentRound} — ${agent.name} [resumed]`,
                  agent.systemPrompt,
                  prompt,
                  agent.model, // Pass agent's model
                );
                agentOutputs[agent.name] = output;
                selfVotes[agent.name] = detectVote(output);
              } catch (err) {
                console.error(
                  `[swarm_resume] Phase 1 error (${agent.name}): ${err.message}`,
                );
                agentOutputs[agent.name] = `[ERROR: ${err.message}]`;
                selfVotes[agent.name] = "REVISE";
              }
            }

            // --- Phase 2: Cross-review ---
            const crossVotes = {};
            for (const reviewer of agents) {
              crossVotes[reviewer.name] = {};
              for (const reviewed of agents) {
                if (reviewer.name === reviewed.name) continue;
                const prompt = fillTemplate(crossReviewTemplate, {
                  agent_name: reviewed.name,
                  agent_output: agentOutputs[reviewed.name] ?? "(no output)",
                });
                try {
                  const reviewText = await runSession(
                    client,
                    dir,
                    `Swarm Cross-Review R${currentRound} — ${reviewer.name} → ${reviewed.name} [resumed]`,
                    reviewer.systemPrompt,
                    prompt,
                    reviewer.model, // Pass reviewer's model
                  );
                  crossVotes[reviewer.name][reviewed.name] =
                    detectVote(reviewText);
                } catch (err) {
                  console.error(
                    `[swarm_resume] Phase 2 error (${reviewer.name} → ${reviewed.name}): ${err.message}`,
                  );
                  crossVotes[reviewer.name][reviewed.name] = "REVISE";
                }
              }
            }

            // --- Tally ---
            const allSelfVotes = Object.values(selfVotes);
            const allCrossVotes = Object.values(crossVotes).flatMap((v) =>
              Object.values(v),
            );
            const allVotes = [...allSelfVotes, ...allCrossVotes];
            const unanimous =
              allVotes.length > 0 && allVotes.every((v) => v === "APPROVE");

            // --- Phase 3: Compress ---
            const compressedContext = await compressContext(
              client,
              dir,
              currentRound,
              agents,
              agentOutputs,
              selfVotes,
              crossVotes,
              compressTemplate,
            );

            // --- Write to run directory ---
            const ensuredRunDir = await ensureRunDir(dir, runId, "plan");

            const logEntry = [
              `## Round ${currentRound} [resumed]`,
              ``,
              `### Phase 1 — Agent Outputs & Self-Votes`,
              ``,
              ...agents.map(
                (a) =>
                  `#### ${a.name} — self-vote: **${selfVotes[a.name]}**\n\n` +
                  (agentOutputs[a.name] ?? "(no output)") +
                  `\n`,
              ),
              `### Phase 2 — Cross-Review Votes`,
              ``,
              "```json",
              JSON.stringify(crossVotes, null, 2),
              "```",
              ``,
              `### Phase 3 — Compressed Context`,
              ``,
              compressedContext,
              ``,
              `### Result`,
              ``,
              `Self-votes: ${JSON.stringify(selfVotes)}`,
              `All unanimous: **${unanimous}**`,
              ``,
            ].join("\n");

            const runLogPath = join(ensuredRunDir, "debate_log.md");
            await appendLog(runLogPath, "Debate Log", logEntry);

            const consensusRunPath = join(ensuredRunDir, "consensus.md");
            if (unanimous) {
              const lines = [
                `# Consensus Plan`,
                ``,
                `> Run: ${runId}`,
                `> Resumed. Unanimous agreement reached after ${currentRound} round(s).`,
                ``,
                `## Project Brief`,
                ``,
                brief,
                ``,
              ];
              for (const agent of agents) {
                lines.push(
                  `## ${agent.name}`,
                  ``,
                  agentOutputs[agent.name] ?? "",
                  ``,
                );
              }
              await writeFile(consensusRunPath, lines.join("\n"), "utf8");
            }

            await writeMeta(ensuredRunDir, {
              roundsCompleted: currentRound,
              outcome: unanimous ? "consensus" : "in_progress",
              selfVotes,
              updatedAt: new Date().toISOString(),
            });

            await publishCurrent(runLogPath, dir, "output/plan/debate_log.md");
            if (unanimous) {
              await publishCurrent(
                consensusRunPath,
                dir,
                "output/plan/consensus.md",
              );
            }

            if (unanimous) {
              finalResult = {
                runId,
                unanimous: true,
                roundsCompleted: currentRound,
                message:
                  `All agents agreed after round ${currentRound}. ` +
                  `Run ID: ${runId}. ` +
                  `Consensus written to .swarm/output/runs/${runId}/plan/consensus.md ` +
                  `and .swarm/output/plan/consensus.md`,
              };
              break;
            }

            currentContext = compressedContext;
            currentRound++;
          }

          // maxRounds exceeded without consensus
          if (!finalResult) {
            const ensuredRunDir = await ensureRunDir(dir, runId, "plan");
            await writeMeta(ensuredRunDir, {
              outcome: "escalated",
              roundsCompleted: maxRounds,
              updatedAt: new Date().toISOString(),
            });
            finalResult = {
              runId,
              unanimous: false,
              escalate: true,
              roundsCompleted: maxRounds,
              message:
                `Reached the maximum of ${maxRounds} rounds without unanimous agreement. ` +
                `Review .swarm/output/runs/${runId}/plan/debate_log.md and decide.`,
            };
          }

          return JSON.stringify(finalResult);
        },
      }),
    // ---------------------------------------------------------------------
      // swarm_status_live
      //
      // Shows live status of currently running swarm operations
      // ---------------------------------------------------------------------
      swarm_status_live: tool({
        description: "Show live status of currently running swarm agents",
        args: {},
        async execute(args, ctx) {
          const dir = ctx.directory;
          ctx.metadata({ title: "Swarm Live Status" });

          const statusPath = join(dir, '.swarm/output/current_status.json');
          let status = {};
          
          try {
            const content = await readFile(statusPath, 'utf8');
            status = JSON.parse(content);
          } catch (err) {
            return JSON.stringify({
              status: 'idle',
              summary: "## Swarm Live Status\n\n**Status:** 🟡 Idle\n\nNo swarm operation is currently running.\n\nStart a swarm plan, build, or review to see live status.",
            });
          }

          // Format status display
          const statusEmoji = {
            'processing': '🔄',
            'completed': '✅',
            'error': '❌',
            'idle': '🟡'
          }[status.status || 'idle'] || '❓';

          const phaseNames = {
            'plan': '📋 Planning',
            'build': '🔨 Building',
            'review': '🔍 Reviewing'
          };

          const lines = [
            '## Swarm Live Status',
            '',
            `**Status:** ${statusEmoji} ${status.status?.toUpperCase() || 'IDLE'}`,
          ];

          if (status.phase) {
            lines.push(`**Phase:** ${phaseNames[status.phase] || status.phase}`);
          }
          
          if (status.stage) {
            lines.push(`**Stage:** ${status.stage}`);
          }
          
          if (status.agent) {
            lines.push(`**Agent:** ${status.agent}`);
          }
          
          if (status.runId) {
            lines.push(`**Run ID:** ${status.runId}`);
          }
          
          if (status.round) {
            lines.push(`**Round:** ${status.round}`);
          }
          
          if (status.step) {
            lines.push(`**Step:** ${status.step}`);
          }
          
          if (status.focus) {
            lines.push(`**Focus:** ${status.focus}`);
          }
          
          if (status.currentAgent && status.totalAgents) {
            const progress = Math.round((status.currentAgent / status.totalAgents) * 100);
            lines.push(`**Progress:** ${status.currentAgent}/${status.totalAgents} agents (${progress}%)`);
          }
          
          if (status.message) {
            lines.push('', '**Message:**', status.message);
          }
          
          if (status.error) {
            lines.push('', '**Error:**', `❌ ${status.error}`);
          }
          
          if (status.verdict) {
            lines.push('', '**Verdict:**', status.verdict);
          }
          
          lines.push('', `**Last Updated:** ${status.updatedAt || 'Unknown'}`);

          return JSON.stringify({
            status,
            summary: lines.join('\n'),
          });
        },
      }),
    },
  };
};
