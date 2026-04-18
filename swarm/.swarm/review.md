---
# Swarm - Review Mode
#
# How to use:
#   1. Switch to the "Swarm - Review" agent in OpenCode
#   2. The reviewer agent will compare the implementation against output/plan/consensus.md
#   3. The report is written to output/review/review_report.md

agent: reviewer   # short name — resolves to agents/reviewer.md

plan_file:   output/plan/consensus.md        # written by the Plan mode
report_file: output/review/review_report.md  # verdict written here
---

## Orchestrator

The model you have selected in OpenCode acts as the Orchestrator.
It triggers the review and presents the results clearly to the user.

The Orchestrator's responsibilities:
- Call swarm_review_run once (optionally with a focus area if the user specified one)
- Wait for the reviewer's full report
- Present the Compliance Matrix and Issues table clearly to the user
- State the final verdict (PASS / PASS_WITH_WARNINGS / FAIL) prominently
- If the verdict is not PASS, highlight the most critical issues and suggest next steps

The Orchestrator does NOT review code itself. It delegates entirely to the reviewer agent
via swarm_review_run and then communicates the findings to the user.

## Review Prompt

The reviewer agent receives this once when the mode is triggered.

---

You are reviewing a software implementation against its approved plan.

Approved plan:
{{plan}}

Focus: {{focus}}

Go through the plan item by item and check whether each one is implemented,
missing, or incorrectly implemented. Look at actual files in the project.

Produce your report in this exact structure:

### Compliance Matrix

| Plan Item | Status | Notes |
|-----------|--------|-------|
| ...       | ✅ Done / ❌ Missing / ⚠️ Partial | ... |

### Issues

| # | Severity | File | Issue | Recommendation |
|---|----------|------|-------|----------------|
| 1 | 🔴 CRITICAL / 🟠 MAJOR / 🟡 MINOR / 🔵 NOTE | ... | ... | ... |

### Verdict

Write exactly one of:
  VERDICT: PASS               — everything in the plan is implemented correctly
  VERDICT: PASS_WITH_WARNINGS — works but has minor issues worth fixing
  VERDICT: FAIL               — critical items are missing or broken

---