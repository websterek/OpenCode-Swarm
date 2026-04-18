---
# Swarm - Build Mode
#
# How to use:
#   1. Switch to the "Swarm - Build" agent in OpenCode
#   2. The builder agent will read output/plan/consensus.md and implement it step by step
#   3. Each step is appended to output/build/build_log.md

agent: builder   # short name — resolves to agents/builder.md

plan_file: output/plan/consensus.md   # written by the Plan mode
log_file:  output/build/build_log.md  # each step is appended here
---

## Orchestrator

The model you have selected in OpenCode acts as the Orchestrator.
It reads the consensus plan, decides how to break it into steps, and drives the builder.

The Orchestrator's responsibilities:
- Read .swarm/output/plan/consensus.md before doing anything
- Identify logical implementation steps from the plan (e.g. data model, API layer, frontend, tests)
- Call swarm_build_run once per step, in order — do not skip steps
- After each step, check whether the builder flagged any AMBIGUITY lines and note them
- After all steps are done, summarise what was built and list any ambiguities that need follow-up
- Do not modify files directly — only the builder agent does that via swarm_build_run

The Orchestrator does NOT write code itself. It plans the order of steps and delegates.

## Step Prompt

The builder agent receives this once per implementation step.

---

You are implementing an approved technical plan step by step.

Approved plan:
{{plan}}

Current step:
{{step}}

Implement this step completely. Write full file contents — no snippets, no TODOs.
After writing each file, say: FILE WRITTEN: <path>
If something in the plan is ambiguous, say: AMBIGUITY: <what you assumed> and keep going.

---

## LeanKG Integration (Optional)

If [LeanKG](https://github.com/FreePeak/LeanKG) is installed and indexed in this project, the Builder agent can query the knowledge graph to understand existing code structure before writing new files.

### Setup

1. Install LeanKG:
   ```bash
   cargo install leankg
   leankg init
   leankg index ./src
   ```

2. LeanKG's MCP server auto-configures for OpenCode — tools become available automatically.

### Builder Agent Instructions

Add these instructions to `.swarm/agents/builder.md` in the System Prompt section:

```
Before writing or modifying a file:
- If get_context is available, call get_context(file="path/to/file") to see what exists
- If get_dependencies is available, call get_dependencies(file="path/to/file") to see imports
- If get_impact_radius is available, call get_impact_radius(file="path/to/file", depth=2) 
  to check what might break

This helps you:
- Avoid duplicating logic that already exists elsewhere
- Understand the codebase structure before adding new components
- Check for breaking changes before modifying shared modules
- Keep imports and dependencies correctly aligned
```

### Benefits

- **Context-aware implementation** — the builder sees existing patterns and conventions
- **Reduced breaking changes** — impact analysis before modifications
- **Better integration** — new code respects existing architecture

### No Code Changes Required

LeanKG integration is entirely optional and requires no plugin modifications. It's purely instructions to the builder agent. If LeanKG tools aren't available, the agent simply writes code based on the plan alone.

---