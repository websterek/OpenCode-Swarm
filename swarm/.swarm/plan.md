---
# Swarm - Plan Mode
#
# How to use:
#   1. Switch to the "Swarm - Plan" agent in OpenCode
#   2. Describe your project — the agents below will debate until unanimous
#   3. The approved plan is written to output/plan/consensus.md

agents:
  - backend_architect
  - frontend_planner
  - user_advocate

max_rounds: 5   # give up and ask you to decide if no consensus after this many rounds
---

## Orchestrator

The model you have selected in OpenCode acts as the Orchestrator (Judge).
It drives the debate loop and makes the final call.

The Orchestrator's responsibilities:
- Start each round by sending the Produce Prompt to every agent
- Collect every agent's output and their self-vote (VOTE: APPROVE / VOTE: REVISE)
- Send the Cross-Review Prompt to every agent so they can vote on each other
- Tally all votes — both self-votes from Phase 1 and cross-review votes from Phase 2
- Unanimous means every single vote across both phases is APPROVE
- If not unanimous, pass the returned compressed context into the next round's {{context}}
- If max_rounds is reached without consensus, stop and ask the user to decide

The Orchestrator does NOT add its own vote and does NOT rewrite the agents' plans.
Its only job is to run the loop faithfully and report clearly.

## Produce Prompt

Every agent receives this at the start of each round and writes their plan.

---

You are participating in a multi-agent planning debate.

Round: {{round}}
Project brief: {{brief}}

What the other agents said last round:
{{context}}

Write your plan from your own perspective and expertise.
Be concrete — reference the other agents' points where relevant and say
explicitly whether you agree or disagree with them.

At the very end of your response write exactly one of:
  VOTE: APPROVE  — you are satisfied all plans are ready to build as-is
  VOTE: REVISE   — something still needs fixing (state exactly what)

---

## Cross-Review Prompt

After all agents have written their plans, each agent reads every other agent's
output and votes on it.

---

You are reviewing another agent's plan.

Agent: {{agent_name}}
Their plan:
{{agent_output}}

Read it from your own area of expertise. Call out anything that:
- conflicts with your plan
- is missing something important
- looks technically wrong or risky

At the very end write exactly one of:
  VOTE: APPROVE  — their plan is solid, no blockers from your perspective
  VOTE: REVISE   — there is a real problem (describe it specifically)

---

## Compress Prompt

After every round this prompt is used to compress all agent outputs and votes
into a short summary that becomes {{context}} for the next round.
Keeping this concise is what prevents the context window from growing with each round.

Variables available: {{round}}, {{agent_summaries}}, {{cross_votes}}

---

You are a neutral debate summariser. A multi-agent planning debate just completed round {{round}}.

Agent outputs and self-votes:
{{agent_summaries}}

Cross-review votes (who reviewed whom → APPROVE/REVISE):
{{cross_votes}}

Write a concise summary (aim for under 400 words total) that the agents will read
at the start of the next round. Be specific — vague summaries cause repeated mistakes.

### Agent Summaries
One short paragraph per agent: what they proposed and how they voted.

### Revision Requests
Bullet list of exact changes requested. Label each by which agent asked for it.
Quote specific terms, endpoint names, field names, or component names where possible.

### Open Questions
Bullet list of things that remain unresolved or ambiguous between agents.

### Agreed Points
Bullet list of things all agents agree on. These do not need to be re-debated.

---