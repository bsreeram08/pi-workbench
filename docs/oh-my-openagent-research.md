# oh-my-openagent: supervision, continuity, and design research

Reviewed 2026-09-05–06. Upstream snapshot: [`277c854a0152569cd99137e8fa4b7aa9082667df`](https://github.com/code-yeongyu/oh-my-openagent/tree/277c854a0152569cd99137e8fa4b7aa9082667df). Workbench baseline: [`436a60fd420d150ff719b8f6da8de3fedcaae93e`](https://github.com/bsreeram08/pi-workbench/tree/436a60fd420d150ff719b8f6da8de3fedcaae93e).

Three independent source investigations covered supervision, delegation/model continuity, and review/recovery. The coordinating investigation covered prompt construction and frontend direction/QA. We inspected implementation, callers, and relevant tests. Upstream was downloaded for reading; it was not installed or executed. Upstream counterexamples below are static deductions, not reproduced incidents. This report proposes changes; it does not implement them or establish a live-model quality improvement.

## Decision

Keep Main Pi responsible for decisions and synthesis. Strengthen the information it receives and the evidence required at handoffs. Preserve Workbench's native approval, exact model selection, writer ownership, and snapshot-bound verification. The useful upstream techniques are contextual reminders, structured assignments, reusable specialist context, constrained review findings, and visual critique of the actual artifact.

First fix our final-round recovery gap. Then add persistent task model preferences, host-recorded handoffs, and coordinator inspection evidence. Add visual evidence and a compact design brief for UI work. Reusing closed writer transcripts is valuable but should follow recovery and ownership work.

## 1. Supervision should happen at the handoff

Upstream's [child-completion hook][completion] distinguishes launch/incomplete responses from completed output and inserts verification guidance around the returned result. In plan mode it also supplies Git change information and validates the child session's lineage. This delivers instructions at the point where the coordinator must act.

Its [Git collector][git-collector] compares against HEAD rather than the pre-delegation workspace. Consequently unrelated dirty files can appear in the change list, changes committed by a child can disappear from it, and inspection errors collapse into an empty result. These observations do not establish which process authored a change.

Workbench currently returns child text and an instruction to inspect in [coordinator-execution.ts](../coordinator-execution.ts). Improve this with a host-recorded handoff:

- Assignment/run/turn identity and actual termination classification.
- Requested and resolved model, reasoning, and policy source. Fallback is absent under the current strict explicit-model policy; record it only if a future policy explicitly authorizes alternatives.
- Before/after workspace identities and changed paths relative to the dirty starting state.
- Native check/artifact references, collected separately from the child's claims.
- Scope anomalies, incomplete work, and the next decision Main Pi must make.

Collection failure must be distinct from no changes. Do not label observed differences as proven authorship when another writer could have intervened. Store private evidence through existing Workbench artifact machinery rather than another source of workflow authority.

### A reminder is not inspection evidence

Upstream [verification instructions][verification-prompt] describe reading code, running checks, exercising the product, and making a decision. However, [reminder construction][reminder-state] adds a task to `verifiedTaskKeys` before those actions occur. A [test][early-verified-test] expects that immediate assignment. On repeated delivery, the hook can then tell the parent to advance as though the task has already been verified. This is a static counterexample to treating that variable as proof of inspection.

Our `assessment` check also only requires nonempty text. Add parent-session inspection references bound to the reviewed workspace: successful diff/source reads, behavior checks, and relevant visual artifacts. A child reading its own files must not count as parent inspection. Access records establish what content was returned to the parent, not whether it read or understood it; partial or truncated reads must remain identifiable. Keep Main Pi's written accept/repair/escalate decision and independent native verification as separate requirements.

## 2. Preserve explicit model intent across related work

Upstream adapters have different contracts:

| Surface | Observed behavior | Consequence for Workbench |
|---|---|---|
| [OpenCode task tool][oc-task] | No call-site `model` parameter; new-task routing uses category/subagent configuration. Continuation branches before new-task routing. | Do not assume examples for this adapter provide exact per-call selection. |
| [Shared resolver][model-resolver] | Configured user models take precedence, explicitly configured fallbacks can be promoted, and several automatic paths use fuzzy matching. | Preserve our exact identity semantics. An explicit fallback list differs from an unrequested substitution. |
| [Senpi task parameters and validation][senpi-validation] | Direct subagents can select a model; category-plus-model combinations, including effective batch inheritance, are rejected. | A domain should provide a default, while a user's explicit task preference can override it visibly. |

Workbench's per-call override is stronger than these flexible resolution paths, but it is not a durable task preference. Every implementation call must repeat the model; an omitted review model follows automatic routing. [Session restoration](../model-routing.ts) also warns and switches an unavailable saved fixed route to durable adaptive routing. That is a visible fallback, but it does not preserve a strict user pin.

Proposed small policy attached to the existing task authority:

```text
domain: ui-ux
actions: implementation, repair, design-review
model: openai-codex/gpt-6-astra
thinking: high
source: explicit-user-preference
fallback: deny
```

Main Pi interprets the scope once and records it for inspection. Native resolution then preserves it across calls and reloads. A conflicting call should expose the conflict; an unavailable pinned model should remain unavailable. Unrelated backend work and general verification need not inherit the UI preference. Work budget remains independent of model identity. No classifier can infer every natural-language scope correctly, so show the interpreted scope rather than hiding it.

## 3. Reuse implementation context without replaying writers

[OpenCode continuation][oc-continuation] recovers the previous child model/variant, anchors the new turn, restores role restrictions, and avoids accepting an old response as the repair result. Its reusable synchronous sessions have [scheduled cleanup][session-cleanup], so this is bounded continuity, not indefinite persistence.

[Senpi restoration][senpi-resume] provides a useful alternative: load a saved transcript, reconstruct allowed tools from current configuration, and wait for a fresh manager-owned turn. Its [tests][senpi-resume-tests] cover missing, corrupt, headerless, directory, and missing-private-directory cases. These are inspected test contracts, not evidence that resumed models produce better work.

Workbench already validates private checkpoints and final session/loadout handshakes in [agent-run-manager.ts](../agent-run-manager.ts). It deliberately rejects messaging terminal runs and does not restore writers. Build on that boundary:

1. Finish and shut down the writer while its lease is held.
2. Retain its validated transcript and immutable task/run/model identity.
3. For a correction, reacquire the lease and revalidate project, plan, workspace, process ownership, and tool permissions.
4. Send only the new bounded correction with a fresh turn identifier. Never replay the original assignment automatically.
5. Keep independent reviewers in separate sessions; give them current artifacts and the relevant finding ledger.

A transcript is context, never approval authority. If the workspace changed independently, Main Pi must reconcile that change before continuing. Keeping a live idle writer outside its lease is a separate and substantially harder ownership problem.

## 4. Make review converge around evidence

The active [Prometheus prompt][prometheus] routes into a shared planning skill. Its [full workflow][plan-workflow] contains more useful review guidance than Momus alone: reviewers see the same complete artifact, revisions target accepted blockers, approvals with notes can pass, and later rounds admit new proven regressions or risks without reopening settled preferences. The skill describes hashes and reviewer/session receipts, but this investigation did not find corresponding enforcement in the OpenCode runtime. Treat those parts as prompt/scaffold contracts.

[Momus][momus] concentrates on usable references, an executable starting point, contradictions, and concrete QA scenarios. That can reduce perfectionist churn, but its approval bias and narrow review scope make it insufficient as the sole correctness or security gate.

Adapt a stable finding record: ID, affected requirement, evidence, consequence, correction, resolution status, and verifying evidence. Present the most important findings first while retaining every material blocker. A new security, privacy, data-integrity, or compatibility issue remains admissible after round one. A reviewer preferring another palette is a suggestion unless it violates an agreed requirement.

Rebuild bounded review history from saved artifacts after reload. Our current Coordinator history is in memory. Preserve the distinction between a protocol-invalid response, transport failure, cancellation, substantive rejection, and passing review with suggestions. One bounded same-artifact format repair can be useful; it must never infer approval from malformed text or discard contradictory findings.

### Keep stronger native approval

Upstream's [final-wave helper][final-gate] scans free text for verdict tokens and counts approvals without reviewer identity. Quoted approval text or repeated delivery of one review are static counterexamples worth testing. Its [event handler][user-message-gate] clears the approval pause on any user-role message. That releases the pause; it does not itself prove the model will approve, but “status?” is not explicit authorization.

Retain Workbench's actual UI confirmation, unique terminal verdict rules, exact reviewed-state checks, and native completion tickets. If review aggregation expands, deduplicate by task, round, role, session/turn, and snapshot. Checkbox counts and model-written receipt prose must not confer authority.

## 5. Recovery is a higher priority than more prompting

Our current Coordinator code has a final-round recovery dead end, established by source inspection and a local deterministic reproduction:

- Planning can pass on the last permitted round, save the draft and exhausted counter, then lose its in-memory ticket on reload. Approval requires the ticket; another review is denied by the counter.
- Execution can similarly pass its final verification and remain `executing` pending Main Pi's completion. Reload removes the ticket; verification is at its limit, while `/start-work` accepts only `approved` plans.
- The counters are persisted before awaiting reviewers. A final-cycle exception can leave `draft` or `executing` state with no completed result and no remaining attempt. The command-level catches do not cover these tool-action bodies.

Sources: [Coordinator planning](../coordinator-planning.ts), [Coordinator execution](../coordinator-execution.ts), and [existing orchestration tests](../tests/workflow-orchestration.test.ts). Reload invalidation is tested; last-round recovery is missing from the baseline test coverage.

The temporary reproduction exercised actual Workbench tool registration, parsing, file-backed state, workspace snapshots, counters, and tickets. Review/check results and leases were mocked; no model or product was run. Both cases confirmed the undesired state transitions (2 passing reproduction tests, 8 assertions): with one plan-review round, successful review followed by `session_start` made approval require a missing native ticket and made re-review fail at the limit, leaving `draft`; with zero fix loops, passing execution verification followed by `session_start` made completion require the missing ticket and made re-verification fail at the limit, leaving `executing`. These test passes confirm the bug, not successful recovery. Final-cycle exceptions remain a separate static finding requiring regression coverage.

Add explicit, bounded read-only recovery. Record attempt lifecycle and input identity, distinguish infrastructure/protocol recovery allowance from substantive revision rounds, and regenerate authority only from newly run native reviews/checks. Preserve all prior artifacts and counters. Recovery must not replay implementation, reinterpret a declined approval, reset budgets indefinitely, or silently accept a changed plan/workspace.

Upstream also separates useful concepts: [compaction context][compaction-context] preserves constraints, decisions, child IDs, and pending review; [epoch guards][compaction-epochs] reject stale asynchronous continuation; [sticky stop][sticky-stop] keeps ordinary chat from restarting work. Adopt those distinctions without treating summaries as fresh authority.

### Detect stagnation without manufacturing progress

Atlas's prompt promises unlimited retry, while its [runtime progress heuristic][atlas-progress] stops after three cycles without successful bash/edit/write. A successful trivial command can count; useful reading or browser inspection may not. Its separate [todo tracker][todo-progress] measures ID/status-map changes, which can include status churn. Neither proves useful work was completed.

Keep an overall native budget. Compare recurring findings and evidence, then require Main Pi to choose a new hypothesis or approach when the same failure recurs. A newly reproduced failure can be meaningful progress without a code edit. Rewording a todo or emitting another status message cannot satisfy acceptance criteria.

## 6. Treat visual quality as a first-class outcome

The shared [design direction guidance][design-direction] captures current-project goals, audience, constraints, taste, and unresolved choices. Its [orchestration document][design-contract] explicitly says that these are declarative prompt semantics rather than a second runtime. That distinction is worth preserving.

For Workbench, use a compact brief attached to the approved task: information hierarchy, visual direction, interaction intent, relevant accessibility constraints, responsive expectations, and deliberate exclusions. Main Pi owns the chosen direction. A specialist proposes improvements against that brief, and Main Pi adjudicates them. Do not let every reviewer restart visual discovery or silently replace the user's preferred direction.

The [visual QA skill][visual-qa] separates defects in the product from defective evidence. If a screenshot is stale, incomplete, or incorrectly captured, repair capture first. Do not rewrite the UI because the screenshot pipeline is broken. Its [design critique guidance][design-review] requires judgment against the same built artifact and labels interaction/accessibility conclusions as inferred unless actually exercised.

Proposed UI acceptance evidence:

- Build/workspace identity, viewport, route/state, capture time, and screenshot digest.
- Actual interactions exercised, with observations distinct from screenshot inference.
- Findings tied to the brief and located on the current surface.
- Main Pi's accept/repair/escalate decision and any explicitly accepted scope tradeoff.

For the flight resume: inspect initial identity/contact visibility, readable HTML alongside the scene, representative project navigation, keyboard operation, reduced motion, and renderer-initialization/context-loss behavior. A passing build does not establish the aircraft's depth, convincing motion, or unobscured content. Facts must remain sourced from the JSON; decorative flight geography cannot imply invented career facts.

Do not import the entire [frontend skill][frontend-skill]. Its universal tooling installation, broad research requirements, and perfect-score targets are prescriptions rather than demonstrated guarantees. Choose checks that protect the requested experience and measure performance without flattening the 3D design to satisfy an arbitrary score.

## 7. Prompt design worth keeping

The [Sisyphus factory][prompt-factory] selects a model-family prompt and supplies available agents, categories, and skills. Capability-aware prompt construction is useful. Family-specific wording is an optimization hypothesis requiring evaluation; it is not proof of superior behavior on that model.

Use a short common Coordinator contract, add only the currently relevant task/design/recovery instructions, and inject host observations after real events. Keep tool availability and exact parameters authoritative. Avoid blanket “always delegate”, loading every loosely related skill, mandatory fan-out for easy work, and repeated full-suite checks without a new reason. Upstream's [category/skill guide][skill-guide] includes those rigid prescriptions. Workbench's existing bounded skill loading is a better foundation.

These are original proposed prompts, not imported upstream prompt text:

**Coordinator**

> Own the task's consequential decisions and acceptance. Give each specialist a bounded outcome and the context needed to deliver it. After its result, inspect the current artifact and evidence, then state what you accept, what needs correction, and why. Preserve the user's model preference and approved direction. Ask only for decisions that depend on the user. Keep native approval and completion separate from your assessment.

**Implementation assignment**

> Implement this slice: {outcome}. Work within {scope}; follow {approved decisions}. Use {exact model policy} and {relevant context}. Demonstrate {observable acceptance checks}. Return changed behavior, evidence, unresolved questions, and any deviation. A report of success does not authorize completion of the overall task.

**Review and repair**

> Review {artifact identity} against {requirements}. For each blocker, provide a stable finding ID, evidence, consequence, and the smallest necessary correction. Keep optional improvements separate. Respect resolved findings unless new evidence invalidates them. If the artifact changed or evidence is defective, report that condition explicitly. Do not convert uncertainty, malformed output, or missing evidence into approval.

**Astra visual review for the flight resume**

> Review the current rendered build against the approved resume-first aviation brief. Inspect desktop and mobile captures and exercise the important interactions. Check whether identity and contact are immediately clear, the aircraft and route support exploration, and resume content stays readable. Locate each issue on the actual surface and name the user impact. Separate aesthetic suggestions, broken behavior, unsupported resume facts, and capture defects. Preserve the approved direction; propose substantial changes for Main Pi to adjudicate. State which conclusions were observed and which remain inferred.

## Implementation order and acceptance tests

| Priority | Bounded change | Required counterexample tests |
|---|---|---|
| P0 | Attempt lifecycle and explicit read-only recovery | Last allowed successful review/check → reload → native recovery → approval/completion; exception mid-review; changed artifact; decline; exhausted recovery allowance; no implementation replay. |
| P1 | Task-scoped exact model preference | UI pin survives omitted model on repair/review, reload, and economy routing; unavailable Astra blocks; explicit replacement updates policy; unrelated tasks retain normal routing. |
| P1 | Host handoff and parent decision evidence | Dirty baseline, child commit, untracked/binary/delete/rename changes, failed collection, partial cancellation, forged child claims, stale parent reads, duplicate result delivery. |
| P1 | Visual evidence against the same build | Stale/wrong-size/partial screenshot, valid image of wrong route, keyboard failure despite attractive screenshot, build passes while WebGL initialization fails, capture failure does not trigger product repair. |
| P2 | Stable blocker ledger and format repair | Suggestions do not cause rejection; proven new privacy regression remains admissible; repeated blockers retain IDs; malformed verdict cannot pass; duplicate reviewer receipt cannot satisfy another role. |
| P2 | Closed-transcript writer continuation | One lease across competing resumes, foreign/corrupt checkpoint, model/tool mismatch, changed plan/worktree, stale prior-turn answer, interrupted start, sticky stop, no original-task replay. |

Reuse the existing workflow state, manager, private artifact store, and check receipts. Avoid introducing another scheduler, editable parallel authority file, or always-live writer fleet.

## Evaluate results, not choreography

Compare the baseline with changes added one at a time: handoff, model preference, inspection/visual evidence, then continuity. Use identical task snapshots, model choices, acceptance checks, and resource budgets; repeat runs and report variation. Include a small nonvisual task so a design-heavy workflow cannot win by adding overhead everywhere.

Useful tasks include the flight-resume brief, a small UI correction, a parser/clearance failure, a misleading child success claim, and a changed workspace after review. Keep evaluation tests outside the writer's editable scope. Score factual accuracy, functional failures, accessibility, independent visual preference, missed blockers, unnecessary scope changes, user interruptions, latency, and cost. An inspection log alone is not a quality score. No numerical quality or token-saving gain is established by this source review.

Upstream [licensing][license] includes a Sustainable Use License and third-party terms. The recommendation is to implement these mechanisms independently with original wording; no upstream prompt or implementation files were copied into Workbench.

[completion]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/tool-execute-after-subagent-completion.ts#L74
[git-collector]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/utils/src/git-worktree/collect-git-diff-stats.ts#L8
[verification-prompt]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/prompts-core/prompts/atlas/gpt.md#L272
[reminder-state]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/subagent-completion-reminder.ts#L108
[early-verified-test]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/tool-execute-after-background-launch.test.ts#L255
[oc-task]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/tools/delegate-task/tools.ts#L62
[model-resolver]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/delegate-core/src/model-selection.ts#L86
[senpi-validation]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/senpi-task/src/tools/task/validation.ts#L96
[oc-continuation]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/tools/delegate-task/sync-continuation.ts#L62
[session-cleanup]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/tools/delegate-task/sync-session-cleanup.ts#L15
[senpi-resume]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/senpi-task/src/runners/in-process.ts#L177
[senpi-resume-tests]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/senpi-task/src/runners/in-process-resume-session.test.ts#L73
[prometheus]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/prompts-core/prompts/prometheus/default.md
[plan-workflow]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/ulw-plan/references/full-workflow.md#L182
[momus]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/agents/momus-gpt-5-6.ts#L8
[final-gate]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/final-wave-approval-gate.ts#L4
[user-message-gate]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/event-handler.ts#L66
[compaction-context]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/compaction-context-injector/compaction-context-prompt.ts#L28
[compaction-epochs]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/todo-continuation-enforcer/compaction-guard.ts#L13
[sticky-stop]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/stop-continuation-guard/hook.ts#L34
[atlas-progress]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/atlas/tool-progress.ts#L3
[todo-progress]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/hooks/todo-continuation-enforcer/session-state.ts#L43
[design-direction]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/frontend/references/designpowers/lane-a-direction.md
[design-contract]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/frontend/references/designpowers/orchestration.md
[visual-qa]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/visual-qa/SKILL.md#L41
[design-review]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/frontend/references/designpowers/lane-c-review.md
[frontend-skill]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/shared-skills/skills/frontend/SKILL.md
[prompt-factory]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/agents/sisyphus-agent-factory.ts#L70
[skill-guide]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/packages/omo-opencode/src/agents/dynamic-agent-category-skills-guide.ts#L48
[license]: https://github.com/code-yeongyu/oh-my-openagent/blob/277c854a0152569cd99137e8fa4b7aa9082667df/LICENSE.md

## Implementation follow-through

The Coordinator now has explicit bounded recovery, task/domain model pins, host-authored dirty-baseline handoffs, native parent source/PNG inspection receipts, an approved design brief, advisory recurring-finding IDs, and same-runtime closed writer transcript continuation. See [Coordinator usage](coordinator-planning.md) and [regression/live test recipes](testing-harness.md).

Limits remain explicit: inspection proves returned content, not comprehension; PNG registration does not certify capture time/build/behavior; finding text fingerprints are advisory; transcript continuation does not survive manager reload. The automatic pipeline and standalone delegation retain their separate routing behavior. No upstream runtime or prompt collection was installed or copied wholesale.
