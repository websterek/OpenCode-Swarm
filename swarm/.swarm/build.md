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