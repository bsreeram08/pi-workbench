import type { AgentResult, AgentSpec } from "./types.ts";
import { WORKBENCH_OPERATING_CONTRACT } from "./operating-contract.ts";
import { INTENT_DISCIPLINE } from "./prompt-discipline.ts";

export function buildSpecialistSystemPrompt(agent: AgentSpec, _reprompterPath: string, implementation = false): string {
  return `You are the ${agent.title} in Pi Workbench.

Role: ${agent.description}

${WORKBENCH_OPERATING_CONTRACT}

This is a project-scoped council. The user's stated intent is the source of truth. Clarify missing details and provide evidence; distinguish your recommendations from what the user requested.

${INTENT_DISCIPLINE}

Clarify intent, constraints, and observable success where needed. Use the supplied task context rather than searching outside your delegated access for additional prompt frameworks.

Use the QMD evidence supplied in the task when prior project knowledge, decisions, or documentation could change your answer. You also have a read-only \`qmd_search\` tool for focused follow-up retrieval; cite the document paths it returns.

Applicable repository instructions and selected skill content are supplied explicitly in your delegated context. Use only relevant supplied guidance. Missing skills or references do not widen your delegated file access.

${implementation ? "You may modify files only because this is an implementation role. Respect the implementation brief, run the project's real tests, and never claim completion without visible test evidence." : "You are READ-ONLY for this phase. Do not write, edit, delete, commit, or generate project files. You may inspect the repository and run safe read-only analysis commands."}

Do not defer all useful thinking to another agent. State your own position, what would change your mind, and the questions the user must answer.
`;
}

export function formatAgentResults(results: AgentResult[]): string {
  return results
    .map((result) => {
      const status = result.exitCode === 0 ? "completed" : `failed (${result.error ?? "unknown error"})`;
      return `## ${result.title} — ${status}\n\n${result.output}`;
    })
    .join("\n\n---\n\n");
}

export function buildRoundTask(
  round: number,
  topic: string,
  intent: string,
  decisions: string,
  qmdContext: string,
  priorTranscript: string,
  checkpoint: string,
): string {
  const instruction = round === 1
    ? "Independently assess the stated idea. Explain your understanding, distinguish explicit requirements from assumptions, argue for and against proceeding, and ask only unresolved questions that materially affect the outcome. Do not produce implementation code."
    : round === 2
      ? "Challenge the other specialists' positions. Identify agreements, contradictions, missing constraints, and questions that would materially change the decision. Do not converge just to be agreeable."
      : "Move from debate to decision. State what is now understood, what remains unresolved, the recommended intent, explicit non-goals, and the decisions the user must approve. Preserve meaningful disagreement rather than hiding it.";

  return `Pi Workbench round ${round}.

USER'S IDEA:
${topic}

CURRENT PROJECT INTENT (may be empty):
${intent || "(no approved intent document yet)"}

DECISION LOG:
${decisions || "(no decisions recorded yet)"}

QMD KNOWLEDGE:
${qmdContext}

PRIOR COUNCIL TRANSCRIPT:
${priorTranscript || "(this is the first round)"}

USER CHECKPOINT INPUT:
${checkpoint || "(none)"}

TASK:
${instruction}

Return Markdown with these headings:
## Understanding
## Position
## For
## Against
## Assumptions
## Questions
## Evidence and QMD References
## What Would Change My Mind
## Proposed Decisions
`;
}

export function buildLeadTask(
  topic: string,
  roundTranscript: string,
  decisions: string,
  qmdContext: string,
): string {
  return `You are the Pi Workbench lead. Synthesize the council into durable project documents. The purpose is to understand and specify the user's intent, not to rush into coding.

USER'S IDEA:
${topic}

COUNCIL TRANSCRIPT:
${roundTranscript}

EXISTING DECISIONS:
${decisions || "(none)"}

QMD KNOWLEDGE:
${qmdContext}

Produce exactly these three sections, with the marker lines unchanged:
=== INTENT DOCUMENT ===
Write a complete, concrete Intent.md in Markdown. Include: outcome, users, problem, in-scope requirements, explicit non-goals, constraints, assumptions, open questions, decision criteria, and measurable success criteria. Do not claim a requirement is decided when the user has not approved it.
=== DECISION RECORD ===
Write a concise append-only decision entry. Include the decision, context, alternatives considered, rationale, consequences, and unresolved questions. Clearly label council recommendations versus user-approved decisions.
=== LEAD SUMMARY ===
Summarize the strongest agreement, remaining disagreement, and the next user decision needed.

Do not include code. Do not make up user approval. If the intent is still ambiguous, say so plainly in the open questions and lead summary.
`;
}

export function buildPlanningTask(
  agent: AgentSpec,
  topic: string,
  intent: string,
  decisions: string,
  qmdContext: string,
): string {
  return `You are preparing the ${agent.title} implementation perspective for a project whose approved intent is below.

TOPIC:
${topic}

INTENT DOCUMENT:
${intent}

DECISIONS:
${decisions}

QMD KNOWLEDGE:
${qmdContext}

Do not implement anything. Produce a practical implementation brief for your specialty:
- concrete work items
- dependencies and sequencing constraints
- files or subsystems likely involved (verify paths before naming them)
- failure modes and edge cases
- exact tests or checks that prove your part is complete
- questions that still block safe implementation

End with a section titled \`## Recommendation to the Implementer\`.
`;
}

export function buildImplementerTask(
  topic: string,
  intent: string,
  decisions: string,
  plan: string,
  qmdContext: string,
): string {
  return `Implement the approved Pi Workbench intent in the current project.

TOPIC:
${topic}

INTENT DOCUMENT (source of truth):
${intent}

DECISIONS:
${decisions}

PARALLEL SPECIALIST IMPLEMENTATION BRIEFS:
${plan}

RELEVANT QMD KNOWLEDGE:
${qmdContext}

Rules:
1. Start by inspecting the repository and its documented commands.
2. Implement only the approved intent. Do not silently expand scope.
3. Use the existing project patterns and preserve unrelated behavior.
4. Add or update deterministic tests for every behavior you change.
5. Run the project's real test/build/lint checks, not only a type check.
6. If a test fails, diagnose and fix it, then rerun the test. Continue until the relevant checks pass or report a concrete blocker.
7. Do not claim success from a plan, a diff, or a build alone. The final report must list exact commands and their results.
8. Do not commit unless the project convention explicitly requires it.

Return:
## Changes
## Tests Run
## Test Evidence
## Remaining Blockers
## Completion Claim
`;
}

export function buildMergeTask(
  topic: string,
  intent: string,
  decisions: string,
  plan: string,
  workerReports: string,
  workspaceManifest: string,
): string {
  return `You are the Pi Workbench integration implementer. Parallel workers independently implemented the approved intent in isolated Git worktrees. Integrate the best compatible work into the current main working tree.

TOPIC:\n${topic}

INTENT (source of truth):\n${intent}

DECISIONS:\n${decisions}

IMPLEMENTATION PLAN:\n${plan}

WORKER REPORTS:\n${workerReports}

WORKSPACE MANIFEST:\n${workspaceManifest}

Inspect each worker path directly with git status/diff and file reads. Do not blindly copy whole directories or cherry-pick unrelated work. Reconcile conflicts according to the intent and project conventions. Preserve unrelated main-tree behavior. Add or retain deterministic tests. Run the canonical relevant tests and fix failures before reporting.

Return:
## Integrated Changes
## Worker Ideas Rejected
## Tests Run
## Test Evidence
## Remaining Blockers
## Completion Claim
`;
}

export function buildReviewTask(
  agent: AgentSpec,
  topic: string,
  intent: string,
  implementationOutput: string,
): string {
  return `Review the implementation against the Pi Workbench intent as the ${agent.title}.

TOPIC:
${topic}

INTENT:
${intent}

IMPLEMENTER REPORT:
${implementationOutput}

Inspect the actual working tree and git diff. You are read-only. Run relevant tests or analysis when useful. Do not praise without evidence.

Return exactly:
## Verdict
One of: PASS, CHANGES_REQUIRED, or BLOCKED.
## Findings
Each finding must include severity (critical, warning, suggestion), file/path, evidence, and a concrete fix.
## Verification Gaps
List tests or checks that are missing or not trustworthy.
## Evidence
List commands you ran and their results.
`;
}

export function buildVerifierTask(topic: string, intent: string, implementationOutput: string): string {
  return `Act as the independent verification gate for this Pi Workbench implementation.

TOPIC:
${topic}

INTENT:
${intent}

IMPLEMENTER REPORT:
${implementationOutput}

Inspect the actual working tree. Read AGENTS.md/CLAUDE.md and project configuration to discover the canonical verification commands. Run the narrowest complete test suite that proves the intent, plus required build/lint checks when documented. Do not modify files.

Execute checks with workbench_verify (literal argv, a descriptive kebab-case criterionIds value, and the appropriate evidence kind). Completion requires host-recorded checks on unchanged code; ordinary bash output or a text marker alone cannot pass. Inspect the results: a zero exit does not establish that the checks cover the requested behavior.

A result is VERIFIED only when the relevant tests actually pass and the output is visible. A build-only result is not enough. If tests cannot run, say BLOCKED. Never infer passing tests from an agent's claim.

Return exact commands and abbreviated output. End with exactly one marker:
<verified/> only when all relevant checks passed.
<failed/> when any check failed, was skipped, or could not be run.
`;
}

export function buildFixTask(topic: string, intent: string, implementationOutput: string, reviews: string, verification: string): string {
  return `Fix the implementation until it satisfies the Pi Workbench intent and verification gate.

TOPIC:
${topic}

INTENT:
${intent}

IMPLEMENTER REPORT:
${implementationOutput}

PARALLEL REVIEW REPORTS:
${reviews}

VERIFICATION REPORT:
${verification}

Make the smallest correct changes. Address critical and warning findings that violate the intent. Add regression tests where needed. Run the real relevant tests after each fix and continue until they pass. Do not claim completion without exact test evidence.

Return ## Changes, ## Tests Run, ## Test Evidence, ## Remaining Blockers, and ## Completion Claim.
`;
}
