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
// Helpers
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
// Prefers a fenced block under "## System Prompt", then plain text under that
// heading, then falls back to everything after the frontmatter.
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
async function runSession(client, dir, title, systemPrompt, promptText) {
  let sessionId;
  try {
    const created = await client.session.create({
      body: { title },
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

      // -- swarm-plan -------------------------------------------------------
      config.agent["swarm-plan"] = {
        mode: "primary",
        description: "Multi-agent debate → consensus.md",
        maxSteps: 30,
        permission: { edit: "allow", bash: "allow" },
        prompt:
          "You are the Swarm Plan Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "When the user describes a project, run the debate loop: " +
          "call swarm_debate with round=1 and the user's message as brief. " +
          "After each call check unanimous. If false, call swarm_debate again " +
          "with round+1 and the returned context. If true, report that " +
          "consensus.md has been written. If escalate is true, summarise the " +
          "disagreements and ask the user to decide.",
        // Spread user overrides on top so config.json can still pin a model
        // or change any field without touching this file.
        ...config.agent["swarm-plan"],
      };

      // -- swarm-build ------------------------------------------------------
      config.agent["swarm-build"] = {
        mode: "primary",
        description: "Implements consensus.md step by step",
        maxSteps: 60,
        permission: { edit: "allow", bash: "allow" },
        prompt:
          "You are the Swarm Build Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "Read .swarm/output/plan/consensus.md to understand the approved plan. " +
          "Break it into logical implementation steps and call swarm_build_run " +
          "once per step, in order. After all steps, summarise what was built.",
        ...config.agent["swarm-build"],
      };

      // -- swarm-review -----------------------------------------------------
      config.agent["swarm-review"] = {
        mode: "primary",
        description: "Reviews implementation against consensus.md",
        maxSteps: 10,
        permission: { edit: "allow", bash: "allow" },
        prompt:
          "You are the Swarm Review Orchestrator. " +
          "Your detailed instructions are in the system prompt below. " +
          "Call swarm_review_run to compare the implementation against the " +
          "approved plan. Present the compliance matrix and verdict clearly.",
        ...config.agent["swarm-review"],
      };

      // -- swarm-init (lightweight, only used by the /swarm_init command) ---
      config.agent["swarm-init"] = {
        mode: "primary",
        description: "Initialises .swarm/ in the current project",
        maxSteps: 3,
        permission: { edit: "allow" },
        prompt:
          "You are the Swarm Init agent. " +
          "Call the swarm_init tool to copy the default .swarm/ template into " +
          "this project, then tell the user what was created and how to get started.",
        ...config.agent["swarm-init"],
      };

      // -- /swarm_init command ----------------------------------------------
      // Only register if the user hasn't already defined their own version.
      if (!config.command["swarm_init"]) {
        config.command["swarm_init"] = {
          description: "Set up .swarm/ in this project (copies the default template)",
          agent: "swarm-init",
          template:
            "Initialise this project with the Swarm setup. " +
            "Call swarm_init to copy the template files into .swarm/",
        };
      }
    },

    // -----------------------------------------------------------------------
    // Inject the ## Orchestrator section from the relevant mode file into the
    // orchestrator's system prompt at session start.
    // This means editing .swarm/plan.md (or build.md / review.md) changes
    // orchestrator behaviour immediately with no code changes required.
    // -----------------------------------------------------------------------
    "experimental.chat.system.transform": async (_input, output) => {
      const systemText = output.system.join("\n");

      // Only act on swarm orchestrator sessions
      if (!systemText.includes("Swarm") || !systemText.includes("Orchestrator")) {
        return;
      }

      let modeFile = null;
      if (systemText.includes("Swarm Plan Orchestrator"))    modeFile = ".swarm/plan.md";
      else if (systemText.includes("Swarm Build Orchestrator")) modeFile = ".swarm/build.md";
      else if (systemText.includes("Swarm Review Orchestrator")) modeFile = ".swarm/review.md";

      if (!modeFile) return;

      // The hook doesn't expose the project directory directly — ask the client.
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
      //
      // Copies the default .swarm/ template from the plugin directory into
      // the current project. Safe to customise the template at:
      //   ~/.config/opencode/swarm/.swarm/
      // Those edits become the new default for every future /swarm_init call.
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

          // Verify the template directory exists next to this plugin file
          try {
            await stat(TEMPLATE_DIR);
          } catch {
            return JSON.stringify({
              error:
                `Template directory not found at ${TEMPLATE_DIR}. ` +
                "Re-check your opencode swarm plugin installation.",
            });
          }

          // Collect every file in the template
          let templateFiles;
          try {
            templateFiles = await collectFiles(TEMPLATE_DIR);
          } catch (err) {
            return JSON.stringify({ error: `Failed to read template: ${err.message}` });
          }

          const created = [];
          const skipped = [];
          const errors = [];

          for (const relFile of templateFiles) {
            const dest = join(dir, ".swarm", relFile);
            const src  = join(TEMPLATE_DIR, relFile);

            // Check whether destination already exists
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

          // Also ensure the output directories exist (they are not in the template
          // because they are runtime-generated, but the agents need them to exist).
          for (const outDir of [
            join(dir, ".swarm/output/plan"),
            join(dir, ".swarm/output/build"),
            join(dir, ".swarm/output/review"),
          ]) {
            try {
              await mkdir(outDir, { recursive: true });
            } catch {
              // ignore
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
            errors.forEach(({ file, error }) => lines.push(`  ! ${file}: ${error}`));
          }

          lines.push(
            "\nNext steps:",
            "  1. Switch to the \"Swarm - Plan\" agent",
            "  2. Describe your project",
            "  3. The agents in .swarm/plan.md will debate until unanimous",
            "  4. Review .swarm/output/plan/consensus.md",
            "  5. Switch to \"Swarm - Build\" to implement the plan",
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
      //   Each agent includes a self-vote (VOTE: APPROVE / VOTE: REVISE)
      //   at the end of their output. This vote IS counted toward consensus.
      //
      // Phase 2 — Cross-Review
      //   Every agent reads every other agent's output and votes on it.
      //   These votes are also counted.
      //
      // Unanimous means ALL votes from both phases are APPROVE.
      //
      // The orchestrator calls this repeatedly, incrementing round each time
      // and passing back the context string, until unanimous === true.
      // ---------------------------------------------------------------------
      swarm_debate: tool({
        description:
          "Run one round of the multi-agent planning debate. " +
          "Each agent self-votes in Phase 1 and cross-votes in Phase 2. " +
          "Unanimous requires every vote (both phases) to be APPROVE. " +
          "Call repeatedly, incrementing round and passing back context, until unanimous is true.",
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
              "The context string returned by the previous round. Omit on round 1.",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          ctx.metadata({ title: `Swarm Plan — Round ${args.round}` });

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
            return JSON.stringify({
              unanimous: false,
              escalate: true,
              message:
                `Reached the maximum of ${maxRounds} rounds without unanimous agreement. ` +
                "Review .swarm/output/plan/debate_log.md and decide.",
            });
          }

          // -- Validate required sections -----------------------------------
          const produceTemplate = extractSection(modeContent, "Produce Prompt");
          const crossReviewTemplate = extractSection(modeContent, "Cross-Review Prompt");

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

          // -----------------------------------------------------------------
          // Phase 1 — Produce
          // Each agent writes their plan. Their self-vote is parsed from the
          // output and recorded in selfVotes[agent.name].
          // -----------------------------------------------------------------
          const agentOutputs = {};  // agent.name → full output text
          const selfVotes    = {};  // agent.name → "APPROVE" | "REVISE"

          for (const agent of agents) {
            const prompt = fillTemplate(produceTemplate, {
              round:   String(args.round),
              brief:   args.brief,
              context: args.context ?? "This is the first round — no prior context.",
            });

            try {
              const output = await runSession(
                client,
                dir,
                `Swarm Plan R${args.round} — ${agent.name}`,
                agent.systemPrompt,
                prompt,
              );
              agentOutputs[agent.name] = output;
              selfVotes[agent.name]    = detectVote(output);
            } catch (err) {
              console.error(`[swarm_debate] Phase 1 error (${agent.name}): ${err.message}`);
              agentOutputs[agent.name] = `[ERROR: ${err.message}]`;
              selfVotes[agent.name]    = "REVISE";
            }
          }

          // -----------------------------------------------------------------
          // Phase 2 — Cross-Review
          // Each agent reads every other agent's output and votes on it.
          // crossVotes[reviewer.name][reviewed.name] = "APPROVE" | "REVISE"
          // -----------------------------------------------------------------
          const crossVotes = {};

          for (const reviewer of agents) {
            crossVotes[reviewer.name] = {};

            for (const reviewed of agents) {
              if (reviewer.name === reviewed.name) continue;

              const prompt = fillTemplate(crossReviewTemplate, {
                agent_name:   reviewed.name,
                agent_output: agentOutputs[reviewed.name] ?? "(no output)",
              });

              try {
                const reviewText = await runSession(
                  client,
                  dir,
                  `Swarm Cross-Review R${args.round} — ${reviewer.name} → ${reviewed.name}`,
                  reviewer.systemPrompt,
                  prompt,
                );
                crossVotes[reviewer.name][reviewed.name] = detectVote(reviewText);
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
          const allSelfVotes  = Object.values(selfVotes);
          const allCrossVotes = Object.values(crossVotes).flatMap((v) => Object.values(v));
          const allVotes      = [...allSelfVotes, ...allCrossVotes];
          const unanimous     = allVotes.length > 0 && allVotes.every((v) => v === "APPROVE");

          // Build context summary for the next round
          const newContext = agents
            .map(
              (a) =>
                `=== ${a.name} — self-vote: ${selfVotes[a.name]} ===\n` +
                (agentOutputs[a.name] ?? "(no output)"),
            )
            .join("\n\n");

          // -----------------------------------------------------------------
          // Write consensus.md when unanimous
          // -----------------------------------------------------------------
          const consensusRelPath = "output/plan/consensus.md";
          if (unanimous) {
            await mkdir(join(dir, ".swarm/output/plan"), { recursive: true });
            const lines = [
              `# Consensus Plan`,
              ``,
              `> Unanimous agreement reached after ${args.round} round(s).`,
              ``,
              `## Project Brief`,
              ``,
              args.brief,
              ``,
            ];
            for (const agent of agents) {
              lines.push(`## ${agent.name}`, ``, agentOutputs[agent.name] ?? "", ``);
            }
            await writeFile(
              join(dir, `.swarm/${consensusRelPath}`),
              lines.join("\n"),
              "utf8",
            );
          }

          // -----------------------------------------------------------------
          // Append to debate log
          // -----------------------------------------------------------------
          await mkdir(join(dir, ".swarm/output/plan"), { recursive: true });

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
            `### Result`,
            ``,
            `Self-votes:  ${JSON.stringify(selfVotes)}`,
            `All unanimous: **${unanimous}**`,
            ``,
          ].join("\n");

          await appendLog(
            join(dir, ".swarm/output/plan/debate_log.md"),
            "Debate Log",
            logEntry,
          );

          return JSON.stringify({
            round: args.round,
            unanimous,
            selfVotes,
            crossVotes,
            agentOutputs,
            context: newContext,
            message: unanimous
              ? `All agents agreed (self + cross votes) after round ${args.round}. ` +
                `Consensus written to .swarm/${consensusRelPath}`
              : `Round ${args.round} complete — not unanimous. ` +
                `Self-votes: ${JSON.stringify(selfVotes)}. ` +
                `Call swarm_debate with round=${args.round + 1} and pass the returned context.`,
          });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_build_run
      //
      // Sends one implementation step to the Builder agent defined in
      // .swarm/build.md and appends the output to the build log.
      // The orchestrator calls this once per step after reading consensus.md.
      // ---------------------------------------------------------------------
      swarm_build_run: tool({
        description:
          "Run one implementation step using the Builder agent from .swarm/build.md. " +
          "Call once per step after reading consensus.md.",
        args: {
          step: tool.schema
            .string()
            .describe("What to implement in this step, taken from the consensus plan."),
        },
        async execute(args, ctx) {
          const dir = ctx.directory;
          ctx.metadata({ title: `Swarm Build — ${args.step.slice(0, 60)}` });

          // -- Read mode file -----------------------------------------------
          const modeContent = await readProjectFile(dir, ".swarm/build.md");
          if (!modeContent) {
            return JSON.stringify({
              error: "No .swarm/build.md found. Run /swarm_init first.",
            });
          }

          const fm       = parseFrontmatter(modeContent);
          const agentRaw = fm.agent    ?? "builder";
          const planFile = fm.plan_file ?? "output/plan/consensus.md";
          const logFile  = fm.log_file  ?? "output/build/build_log.md";

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

          // -- Load plan ----------------------------------------------------
          const plan = await readProjectFile(dir, `.swarm/${planFile}`);
          if (!plan) {
            return JSON.stringify({
              error:
                `Consensus plan not found at .swarm/${planFile}. ` +
                "Run Swarm - Plan first.",
            });
          }

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
            );
          } catch (err) {
            return JSON.stringify({ error: err.message });
          }

          // -- Append to build log ------------------------------------------
          await mkdir(join(dir, ".swarm/output/build"), { recursive: true });
          await appendLog(
            join(dir, `.swarm/${logFile}`),
            "Build Log",
            `## Step: ${args.step}\n\n${output}`,
          );

          return JSON.stringify({ step: args.step, output });
        },
      }),

      // ---------------------------------------------------------------------
      // swarm_review_run
      //
      // Runs the Reviewer agent from .swarm/review.md against consensus.md
      // and writes the structured report to the configured report_file.
      // ---------------------------------------------------------------------
      swarm_review_run: tool({
        description:
          "Review the implementation against consensus.md using the agent from .swarm/review.md.",
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
          ctx.metadata({ title: "Swarm Review" });

          // -- Read mode file -----------------------------------------------
          const modeContent = await readProjectFile(dir, ".swarm/review.md");
          if (!modeContent) {
            return JSON.stringify({
              error: "No .swarm/review.md found. Run /swarm_init first.",
            });
          }

          const fm         = parseFrontmatter(modeContent);
          const agentRaw   = fm.agent        ?? "reviewer";
          const planFile   = fm.plan_file    ?? "output/plan/consensus.md";
          const reportFile = fm.report_file  ?? "output/review/review_report.md";

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

          // -- Run reviewer -------------------------------------------------
          const prompt = fillTemplate(reviewTemplate, {
            plan,
            focus: args.focus ?? "full review — cover everything in the plan",
          });

          let output;
          try {
            output = await runSession(
              client,
              dir,
              "Swarm Review",
              agent.systemPrompt,
              prompt,
            );
          } catch (err) {
            return JSON.stringify({ error: err.message });
          }

          // -- Write report -------------------------------------------------
          await mkdir(join(dir, ".swarm/output/review"), { recursive: true });
          await writeFile(
            join(dir, `.swarm/${reportFile}`),
            `# Review Report\n\n${output}`,
            "utf8",
          );

          return JSON.stringify({
            output,
            reportPath: `.swarm/${reportFile}`,
          });
        },
      }),
    },
  };
};
