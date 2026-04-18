# OpenCode Swarm Plugin

A multi-agent orchestration system for OpenCode that brings **collaborative AI planning** to software development. Instead of a single agent working alone, Swarm runs multiple specialized agents in a structured debate loop until they reach unanimous agreement — then builds and reviews the implementation.

---

## What is Swarm?

Swarm separates software development into three autonomous phases:

1. **Plan** — Multiple agents debate until unanimous consensus
2. **Build** — A builder agent implements the approved plan step-by-step
3. **Review** — A reviewer agent compares implementation against the plan

Each phase is driven by an **Orchestrator** — the model you select in OpenCode acts as the judge, running the loops faithfully without adding its own opinions.

---

## How It Works

### Plan Phase

```
User: "Build a task management SaaS with teams, projects, deadlines, and RBAC."

Swarm - Plan agent:
  Round 1:
    Phase 1 → Backend Architect writes their plan (API, data model, auth) → self-votes
              Frontend Planner writes their plan (UI, components, flows) → self-votes
              User Advocate writes their review (accessibility, UX) → self-votes
    
    Phase 2 → Every agent reads every other agent's plan and votes APPROVE/REVISE
    
    Phase 3 → All outputs + votes compressed into ~400-word summary

  Round 2 (if not unanimous):
    Phase 1/2/3 repeated with the compressed summary as context...
    
  Rounds continue until unanimous or max_rounds exceeded.
  
  Output: .swarm/output/runs/<timestamp>/plan/consensus.md
```

The compressed context (Phase 3) is the key innovation — without it, passing three agents' full outputs between rounds would blow up the context window. With compression, round N uses ~400 tokens of context regardless of how long each agent's original output was.

### Build Phase

```
User: "Build from plan run 2025-04-18_15-32-01"

Swarm - Build agent:
  Reads the chosen consensus.md
  Breaks it into steps:
    1. "Set up data model" → swarm_build_run(step=..., planSection="Backend Architect")
    2. "Implement API routes" → swarm_build_run(step=..., planSection="Backend Architect")
    3. "Build task board UI" → swarm_build_run(step=..., planSection="Frontend Planner")
    ...
  
  Each swarm_build_run call creates a temporary session with the Builder agent.
  planSection injects only the relevant ## heading from the plan → context stays small.
  
  Output: .swarm/output/runs/<timestamp>/build/build_log.md
```

### Review Phase

```
User: (switches to Swarm - Review)

Swarm - Review agent:
  swarm_review_run(focus="full review")
  
  Reviewer agent compares implementation against consensus.md:
    - Compliance matrix (plan item vs status)
    - Issue table (severity, file, description)
    - Verdict: PASS / PASS_WITH_WARNINGS / FAIL
  
  Output: .swarm/output/runs/<timestamp>/review/review_report.md
```

---

## Installation

### 1. Plugin already installed

If you're reading this, the plugin is at `~/.config/opencode/swarm/plugin.js` and registered in `~/.config/opencode/config.json`.

### 2. Initialize a project

In your project directory:

```bash
/swarm_init
```

This copies the default `.swarm/` template (agents, mode files) into your project. Safe to re-run — won't overwrite existing files.

---

## Usage

### Modes (workflow phases)

Switch between these in the OpenCode agent picker:

| Mode | What it does |
|------|-------------|
| **1-swarm-plan** | Runs debate loop → writes consensus.md |
| **2-swarm-build** | Implements consensus.md step-by-step |
| **3-swarm-review** | Reviews implementation vs plan |

The numeric prefix ensures they appear in workflow order.

### Commands (inline utilities)

Type these from any mode — they run as subtasks without switching context:

| Command | What it does |
|---------|-------------|
| `/swarm_init` | Copy `.swarm/` template into this project |
| `/swarm_status` | List all past runs and their outcomes |
| `/swarm_status <runId>` | Show detail for a specific run |
| `/swarm_resume <runId>` | Resume an interrupted plan debate |
| `/swarm_build_select` | List consensus plans and pick one to build |

---

## Directory Structure

```
.swarm/
├── plan.md            # Plan mode config: agents, prompts, orchestrator
├── build.md           # Build mode config: builder agent, prompts
├── review.md          # Review mode config: reviewer agent, prompt
├── agents/            # Agent definitions (reusable across modes)
│   ├── backend_architect.md
│   ├── frontend_planner.md
│   ├── user_advocate.md
│   ├── builder.md
│   └── reviewer.md
└── output/
    ├── runs/          # Timestamped run history
    │   ├── 2025-04-18_15-32-01/
    │   │   └── plan/
    │   │       ├── meta.json         # runId, brief, agents, outcome, votes
    │   │       ├── debate_log.md     # full per-round log
    │   │       └── consensus.md      # written if unanimous
    │   ├── 2025-04-18_16-10-44/
    │   │   └── build/
    │   │       ├── meta.json         # runId, steps[], startedAt
    │   │       └── build_log.md
    │   └── 2025-04-18_17-05-22/
    │       └── review/
    │           ├── meta.json         # runId, verdict, focus
    │           └── review_report.md
    ├── plan/          # "Current" pointers (copies of latest run)
    │   ├── consensus.md
    │   └── debate_log.md
    ├── build/
    │   └── build_log.md
    └── review/
        └── review_report.md
```

**Why two layers?**
- `runs/<timestamp>/` — immutable history. Compare two plan runs, resume interrupted debates, audit what changed.
- `output/<phase>/` — stable references. The orchestrator always reads `output/plan/consensus.md` so it doesn't need to know about run IDs.

---

## Configuration Files

Each mode is defined by a single Markdown file. No YAML, no templates folder, no cross-referencing.

### `.swarm/plan.md`

```yaml
---
agents:
  - backend_architect
  - frontend_planner
  - user_advocate
max_rounds: 5
---
```

Then three sections:
- **## Orchestrator** — how the judge behaves, when to escalate, what unanimous means
- **## Produce Prompt** — what agents receive at the start of each round (variables: `{{round}}`, `{{brief}}`, `{{context}}`)
- **## Cross-Review Prompt** — what agents receive when reviewing each other (variables: `{{agent_name}}`, `{{agent_output}}`)
- **## Compress Prompt** — how to distil all outputs into a ~400-word summary for the next round (variables: `{{round}}`, `{{agent_summaries}}`, `{{cross_votes}}`)

### `.swarm/build.md`

```yaml
---
agent: builder
plan_file: output/plan/consensus.md
log_file: output/build/build_log.md
---
```

Sections:
- **## Orchestrator** — how to break the plan into steps, when to use `planSection`
- **## Step Prompt** — what the builder receives per step (variables: `{{plan}}`, `{{step}}`)

### `.swarm/review.md`

```yaml
---
agent: reviewer
plan_file: output/plan/consensus.md
report_file: output/review/review_report.md
---
```

Sections:
- **## Orchestrator** — when to call `swarm_review_run`, how to present results
- **## Review Prompt** — what the reviewer receives (variables: `{{plan}}`, `{{focus}}`)

---

## Features

### 1. Run History

Every plan/build/review run gets a timestamped directory under `.swarm/output/runs/<runId>/`. Each run's `meta.json` records:

**Plan runs:**
```json
{
  "runId": "2025-04-18_15-32-01",
  "phase": "plan",
  "brief": "Build a task management...",
  "agents": ["Backend Architect", "Frontend Planner", "User Advocate"],
  "maxRounds": 5,
  "roundsCompleted": 2,
  "outcome": "consensus",
  "selfVotes": { "Backend Architect": "APPROVE", ... },
  "startedAt": "2025-04-18T15:32:01.000Z",
  "updatedAt": "2025-04-18T15:34:15.000Z"
}
```

**Build runs:**
```json
{
  "runId": "2025-04-18_16-10-44",
  "phase": "build",
  "planRunId": "2025-04-18_15-32-01",
  "steps": [
    { "step": "Set up data model", "completedAt": "..." },
    { "step": "Implement API", "completedAt": "..." }
  ],
  "startedAt": "...",
  "updatedAt": "..."
}
```

**Review runs:**
```json
{
  "runId": "2025-04-18_17-05-22",
  "phase": "review",
  "focus": "full review",
  "verdict": "PASS_WITH_WARNINGS",
  "startedAt": "...",
  "updatedAt": "..."
}
```

### 2. Context Compression

After every debate round, a compression step distills all agent outputs + votes into a structured ~400-word summary. This summary becomes the `{{context}}` for the next round.

**Without compression:** Round 3 would receive ~9000 tokens of context (3 agents × 3 rounds × ~1000 tokens).  
**With compression:** Round 3 receives ~400 tokens regardless of how many rounds ran before it.

The compression prompt lives in `plan.md` under `## Compress Prompt` — fully editable. If omitted, a built-in default is used.

### 3. Resume Interrupted Debates

If a plan debate was interrupted (network error, token limit, process killed):

```bash
/swarm_status                  # find the runId of the interrupted run
/swarm_resume 2025-04-18_14-22-10
```

The tool reads the last completed round's compressed context from the debate log and continues the debate from `roundsCompleted + 1`. The resumed rounds are marked `[resumed]` in the log.

### 4. Build from Any Plan

Instead of always building the latest consensus:

```bash
/swarm_build_select            # list all consensus-reached plan runs
```

Then in the `2-swarm-build` agent:
```
Build from plan run 2025-04-18_15-32-01
```

The orchestrator uses that specific plan. Useful for:
- A/B testing different architectures
- Building a feature after the plan was revised
- Comparing implementations from two different plans

### 5. Plan Section Extraction

When calling `swarm_build_run`, the orchestrator can pass a `planSection` argument (e.g. `"Backend Architect"`). The tool injects only that `##` section from `consensus.md` instead of the entire multi-agent plan.

**Context reduction:** A 5000-token consensus.md with three agent sections becomes three ~1600-token injections instead of three 5000-token injections — 70% saving.

The orchestrator's prompt was updated to encourage using `planSection` wherever possible.

---

## Agent Definitions

Agents live in `.swarm/agents/` as Markdown files with YAML frontmatter:

```markdown
---
name: "Backend Architect"
role: "Systems Architect & Backend Planner"
model: "z-ai/glm-5.1"
temperature: 0.2
max_tokens: 32768
description: >
  Plans backend architecture, data models, API contracts...
---

## System Prompt

You are a Systems Architect responsible for backend planning.
You produce specifications, not code...
```

The plugin reads both the frontmatter (model, temperature) and the system prompt (everything under `## System Prompt`).

### Default Agents

| Agent | Role | Model | Use Phase |
|-------|------|-------|-----------|
| **backend_architect** | API, data, infra planning | z-ai/glm-5.1 | Plan |
| **frontend_planner** | UI/UX, component architecture | qwen/qwen3.6-plus | Plan |
| **user_advocate** | End-user perspective, accessibility | moonshotai/kimi-k2 | Plan |
| **builder** | Full-stack implementation | moonshotai/kimi-k2 | Build |
| **reviewer** | Compliance checking | moonshotai/kimi-k2 | Review |

### Adding a New Agent

1. Create `.swarm/agents/my_agent.md` with frontmatter + system prompt
2. Add to `plan.md` frontmatter: `agents: [backend_architect, frontend_planner, my_agent]`
3. Done — next plan run includes it automatically

---

## Tools (API Reference)

These tools are called by the orchestrator agents. You don't call them directly — the agents do.

### `swarm_debate`

Runs one round of the multi-agent planning debate.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `round` | number | yes | Round number (start at 1, increment each call) |
| `brief` | string | yes | Project brief (same every round) |
| `context` | string | no | Compressed context from previous round (omit on round 1) |
| `runId` | string | no | Run ID from round 1 (omit on round 1, pass back on 2+) |

**Returns:** `{ runId, round, unanimous, selfVotes, crossVotes, context, message }`

- `context` — compressed summary to pass to next round
- `unanimous` — `true` if all votes (self + cross) were APPROVE
- `runId` — pass this back on rounds 2+

### `swarm_build_run`

Runs one implementation step.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `step` | string | yes | What to implement (from the plan) |
| `runId` | string | no | Build run ID (omit on step 1, pass back on 2+) |
| `planRunId` | string | no | Which plan run to build from (defaults to current consensus.md) |
| `planSection` | string | no | ## heading name to inject (e.g. "Backend Architect") — reduces context |

**Returns:** `{ runId, step, planSection, planRunId, availableSections, output }`

- `availableSections` — list of `##` heading names in the plan
- Use `planSection` on subsequent steps to keep context small

### `swarm_review_run`

Runs the reviewer agent.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `focus` | string | no | Specific area to review (e.g. "auth", "error handling") |

**Returns:** `{ runId, verdict, output, reportPath, currentPath }`

- `verdict` — `PASS` / `PASS_WITH_WARNINGS` / `FAIL` / `unknown`

### `swarm_init`

Copies the default `.swarm/` template into the current project.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `force` | boolean | no | Overwrite existing files (default: false) |

**Returns:** `{ created[], skipped[], errors[], summary }`

### `swarm_status`

Lists all past runs.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `runId` | string | no | Show detail for one specific run |
| `phase` | string | no | Filter: `"plan"` / `"build"` / `"review"` |

**Returns:** `{ runs[], summary }`

Each run entry includes `runId`, `phase`, `outcome`, `roundsCompleted`, `steps[]`, `verdict`, `files[]`, timestamps.

### `swarm_resume`

Resumes an interrupted plan debate.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `runId` | string | yes | The plan run to resume (use `swarm_status` to find it) |

**Returns:** `{ runId, unanimous, roundsCompleted, message }`

Runs autonomously until consensus or max rounds — no need to call it repeatedly.

---

## Advanced Usage

### LeanKG Integration (Optional)

If [LeanKG](https://github.com/FreePeak/LeanKG) is installed in your project, the Builder agent can query the knowledge graph before writing each file to understand existing dependencies and avoid breaking changes.

**Setup:**

1. Install LeanKG in your project:
   ```bash
   cargo install leankg
   leankg init
   leankg index ./src
   ```

2. LeanKG's MCP server is auto-configured for OpenCode — tools like `get_context`, `get_dependencies`, `get_impact_radius` become available.

**Edit `.swarm/agents/builder.md`** to add this to the System Prompt:

```markdown
Before writing or modifying a file, if LeanKG tools are available:
- Call get_context(file="path/to/file") to understand what already exists
- Call get_dependencies(file="path/to/file") to see what imports it
- Call get_impact_radius(file="path/to/file", depth=2) to check blast radius

This prevents you from breaking existing code or duplicating logic that already exists.
```

No plugin code changes needed — it's just instructions to the agent.

### Customizing the Template

The default `.swarm/` template lives at `~/.config/opencode/swarm/.swarm/`. Edit those files to change what every new `/swarm_init` call copies:

- Add a 4th agent to the plan
- Change the compression prompt style
- Adjust max_rounds default
- Modify agent system prompts

Your edits persist — every new project gets your customized template.

### Comparing Two Plans

```bash
/swarm_status phase=plan       # list all plan runs
```

Pick two runIds and diff them:

```bash
diff .swarm/output/runs/2025-04-18_14-22-10/plan/consensus.md \
     .swarm/output/runs/2025-04-18_15-32-01/plan/consensus.md
```

Or ask an agent:
```
Compare plan runs 2025-04-18_14-22-10 and 2025-04-18_15-32-01.
What changed between them?
```

### Building from an Older Plan

If you ran Plan twice and want to build from the first version:

```bash
/swarm_build_select            # shows both plans with their briefs
```

Then in `2-swarm-build`:
```
Build from plan run 2025-04-18_14-22-10
```

The orchestrator uses that plan's `consensus.md` for all steps.

---

## Architecture Notes

### The Orchestrator ≠ an Agent

The orchestrator is whatever model you have selected in OpenCode's UI. It drives the loops but does NOT add its own vote or rewrite agent outputs. Its only job is to:
1. Call the tools faithfully
2. Pass data between rounds/steps
3. Report outcomes clearly to the user

### Why Compression Matters

A typical plan debate with 3 agents and 3 rounds would accumulate:
- Round 1: 3 agents × 1000 tokens = 3000 tokens of output
- Round 2: needs all of Round 1 as context = 3000 + new 3000 = 6000 total
- Round 3: needs Rounds 1+2 = 9000 + new 3000 = 12,000 total

With compression (Phase 3), every round gets a ~400-token summary of what came before. Context usage stays flat regardless of rounds:
- Round 1: 3000 tokens → compressed to 400
- Round 2: 400 (context) + 3000 (new) → compressed to 400
- Round 3: 400 (context) + 3000 (new) → compressed to 400

**Result:** 90%+ reduction in cumulative context usage.

### Why Votes from Both Phases Count

Each agent's self-vote (Phase 1: `VOTE: APPROVE/REVISE` at the end of their own plan) matters because it signals whether they believe their own proposal is ready. If an agent writes `VOTE: REVISE`, they're saying "I'm not satisfied with what I proposed yet."

Cross-review votes (Phase 2) catch conflicts between agents — Backend Architect might approve their own plan but revise the Frontend Planner's if the API contract is wrong.

Unanimous = **every vote from both phases** is APPROVE. This prevents premature convergence.

### Why Sessions Are Temporary

Every agent invocation (produce, cross-review, compress, build step, review) creates a temporary OpenCode session that is deleted immediately after. This keeps the UI clean and avoids polluting the session list with hundreds of internal debate entries. Only the orchestrator's own session (the one you interact with) persists.

---

## Troubleshooting

### "No .swarm/plan.md found"

Run `/swarm_init` to set up the project.

### "Agent file not found: backend_architect"

Your `.swarm/plan.md` references an agent that doesn't exist in `.swarm/agents/`. Check the name matches exactly (case-sensitive).

### "Max rounds reached without consensus"

The agents couldn't agree after 5 rounds. Review `.swarm/output/runs/<runId>/plan/debate_log.md` to see what they disagreed on. Options:
1. Revise the brief to be more specific or constrained
2. Increase `max_rounds` in `plan.md` frontmatter
3. Remove an agent that's causing gridlock
4. Manually edit one agent's output and resume with `/swarm_resume`

### Compression failed (fallback used)

The Phase 3 compression call timed out or errored. The debate continues with a minimal hand-crafted summary (last 500 chars of each agent's output). Not ideal but non-fatal — check network/API status.

### "Section '<name>' not found in the plan"

The orchestrator passed a `planSection` value that doesn't match any `##` heading in `consensus.md`. The error includes `availableSections` — use one of those on the next call.

---

## Model Selection

The three swarm modes (`1-swarm-plan`, `2-swarm-build`, `3-swarm-review`) deliberately do NOT specify a model in their config. **Whatever model you have selected in OpenCode's UI becomes the orchestrator** for that mode.

Want a cheaper orchestrator for build? Select a cheaper model before switching to `2-swarm-build`.  
Want a smarter orchestrator for planning? Select a reasoning model before switching to `1-swarm-plan`.

To pin a specific model permanently, edit `~/.config/opencode/config.json`:

```json
{
  "plugin": ["./swarm/plugin.js"],
  "agent": {
    "1-swarm-plan": { "model": "anthropic/claude-opus-4-5" }
  }
}
```

---

## Philosophy

1. **Planning beats scrambling.** Consensus before code means fewer rewrites.
2. **Agents don't compromise.** Each agent represents a perspective faithfully — the orchestrator tallies votes, it doesn't merge opinions.
3. **Context is precious.** Compression, section extraction, and run isolation keep token usage manageable even on large projects.
4. **History matters.** Every run is preserved immutably — you can always go back, compare, or resume.
5. **User-editable by default.** Prompts, agent definitions, and orchestrator behavior live in `.md` files you can edit without touching code.

---

## Credits

Built for OpenCode AI as a demonstration of multi-agent orchestration patterns. Uses the `@opencode-ai/plugin` API and runs inside OpenCode's standard agent framework.

Inspired by multi-agent research: AutoGPT, BabyAGI, LangGraph, CrewAI.

---

## License

This plugin (`~/.config/opencode/swarm/`) is provided as-is for use with OpenCode. The default agent definitions and prompts are templates — adapt them to your needs.
