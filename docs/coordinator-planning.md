# Coordinator planning and model selection

`/plan <task>` hands planning to Main Pi using the model already selected for that conversation. Main Pi inspects the project, explains major decisions, asks about real ambiguities, and delegates bounded advice where useful. There is no mandatory Explorer → Planner sequence.

Main Pi submits a complete plan with a terminal task packet to `workbench_plan` using `action: "review"`. Native reviewers inspect it independently. Their findings return to Main Pi, which decides how to revise within the configured review limit. A passing review enables `action: "approve"`; your interactive confirmation approves that exact draft.

`/start-work` confirms implementation and hands control to Main Pi too. It uses `workbench_execute` to assign bounded implementation with an explicit model, inspects actual changes and behavior, and directs corrections. `action: "verify"` runs independent code review and native verification, returning findings to Main Pi without automatic repair. `action: "complete"` records Main Pi's final assessment only when the passing native evidence still matches the workspace and workflow state. Models cannot supply their own completion ticket. Reload clears pending tickets. After inspecting source again, `action: "recover"` can run one fresh read-only verification of the unchanged workspace. It preserves the substantive review budget and never replays implementation.

The Coordinator must call `inspect` with relevant source paths and cite its native `evidenceIds` in `verify` and `complete`. These receipts record the bounded content returned to the parent session and become stale after changes or reload. The assessment records its decisions; neither receipt nor prose proves comprehension. Independent reviewers and observed checks remain separate gates. Reviewers use the configured focused/thorough count. An optional verify `model` selects code reviewers; the separate verification agent follows normal routing.

The native approval ticket cannot be supplied in model output. Changing the saved draft invalidates it. Reloading the extension or changing sessions clears pending tickets and requires review again; already approved plans remain saved. Planning ownership is agent guidance, while review, confirmation, writer leases, and artifact checks are native controls.

Use `/plan --revise <feedback>` to preserve the current task and draft in a new planning attempt before implementation. Findings accumulate across review rounds in the active attempt. `/plan --pipeline <task>` retains automatic planning; `/autopilot` uses that automatic sequence too.

## Ask for a specific model

You can tell Main Pi:

> Use GPT-6 Astra for UI/UX plan review and UI updates. Keep the other agents on the normal routing policy.

The corresponding bounded review call is:

```json
{
  "agent": "quality-reviewer",
  "task": "Review the proposed flight portfolio UI/UX. Inspect the resume data and plan, identify concrete usability issues, and recommend corrections.",
  "model": "openai-codex/gpt-6-astra:high",
  "effort": "heavy"
}
```

Use this with `delegate_task`. For native plan review, supply the same `model` alongside `action: "review"`, `planId`, and the complete `plan` in `workbench_plan`. For updates, `delegate_task` can use `agent: "implementer"` with the same model and a bounded implementation task; writer confirmation and the single-writer lease still apply. Persistent `workbench_agent_start` accepts `model` for read-only specialists.

The model must exist in the session's available registry. Unknown or unavailable models produce a clear error before launch. There is no model substitution, and the call does not change session or project routing defaults. Model suffixes accept `low`, `medium`, or `high`; omitted thinking defaults to `medium`. `effort` controls the work budget independently. In parallel batches, set `model` on each requested `tasks[]` entry; every explicit model is checked before any child starts.

During an approved workflow, use `workbench_execute` with `action: "implement"`, `planId`, a bounded `task`, and `model: "openai-codex/gpt-6-astra:high"`. This path requires an explicit model choice or a matching task preference and holds the writer lease. Each result returns to Main Pi for inspection. An override on one call does not rewrite later automatic lanes. `/start-work --pipeline` retains the automatic implementation/review/repair sequence for users who explicitly choose it.

## Verify the behavior

1. Reload Workbench while idle. In a scratch project, run `/plan Build a small page with a keyboard-accessible navigation menu`.
2. Confirm the activity row appears and Main Pi discusses decisions. Default planning should not immediately launch a mandatory Explorer/Planner chain.
3. Ask for Astra for UI/UX review. Inspect the route receipt: it should show `openai-codex/gpt-6-astra` with the requested thinking level. If unavailable, expect an error and no substitute child.
4. Submit the plan to native review. Rejections should return to Main Pi for correction. A passing review still requires your approval before `/start-work`.
5. Check that the activity row updates during delegation and clears when work ends.
6. Run `/start-work` and request Astra for UI implementation. Main Pi should describe the slice, call `workbench_execute` with Astra, inspect the returned changes, and direct review. Completion requires native gates plus a separate Main Pi assessment; rejection must not silently launch another implementer.

Automated coverage is in `tests/workflow-orchestration.test.ts`, `tests/routing.test.ts`, and `tests/workflow-activity.test.ts`. These tests establish control flow, model propagation, and UI lifecycle behavior; they do not establish that a particular model makes better design decisions.

## Persist model preferences

Main Pi records a scoped user request once using `workbench_model_policy`:

```json
{
  "action": "set",
  "planId": "<current-plan-id>",
  "domain": "ui-ux",
  "actions": ["plan-review", "implement", "repair", "review"],
  "model": "openai-codex/gpt-6-astra:high",
  "reason": "The user requested Astra for UI/UX reviews and updates."
}
```

Later native planning and execution actions pass `domain: "ui-ux"`; omitting `model` resolves to the pin. Conflicting overrides fail and an unavailable pinned model never falls back. Main Pi uses `replace: true` only when the user changes that preference. Unrelated domains retain ordinary routing. Policy survives reload and is bound to the current task. This native Coordinator policy does not change standalone delegation or the explicitly selected automatic pipeline.

## Inspect and decide

Each implementation returns a host-authored handoff: assignment/run identity, requested and resolved route, exit classification, before/after workspace fingerprints, observed changed paths, optional scope anomalies, and separately labeled child claims. Changes are measured against the dirty pre-delegation baseline, including work a child commits. They are observations, not proof of authorship; failed collection is never reported as zero changes. Failed assignments retain a handoff for inspecting partial work.

Call `workbench_execute` with `action: "inspect"`, `planId`, and relevant `paths`; `startLine` selects a later source excerpt. When only deletions remain, `changes: true` returns a native deletion inventory against the earliest retained task baseline. It labels the returned metadata and never claims to return deleted source; added or modified source cannot use this shortcut. Read the returned source, investigate behavior, and cite its receipt IDs in the final assessment. The host rejects unknown, foreign, or stale IDs. Independent reviewers and actual check receipts still decide the native gates. Repeated findings receive advisory text fingerprints; repetition asks Main Pi to reconsider its approach without claiming the finding is true or mechanically proving stagnation.

For visual work, submit a compact `designBrief` with plan review: `direction`, `hierarchy`, `interactions`, `responsiveAccessibility`, and `constraints`. It is reviewed and approved with the plan. During execution, source evidence plus visual evidence is required. `action: "visual"` returns a validated PNG supplied through `artifactPath`, with a reported `route`, `viewport: {width, height}`, and optional interaction `observations`. Its receipt records native dimensions, digest, and registration snapshot. The image's provenance, route, viewport, and behavior remain caller reports: registration does not prove when or from which build it was captured. Inspect the actual image and use browser/test evidence for keyboard, reduced-motion, and fallback behavior. Repair a stale or incorrect capture before treating it as a product defect.

## Recover or continue deliberately

Use `workbench_plan recover` after a passing planning ticket was lost or a review was interrupted. Execution uses `workbench_execute recover` with fresh source/visual evidence and an assessment. Recovery runs fresh reviewers/checks against unchanged inputs, consumes one durable allowance, and cannot bypass a substantive rejection or cancellation. Malformed verdicts are diagnosed separately; they never become approval. Normal review counters and earlier artifacts remain intact. Status messages never resume a stopped run.

A completed writer may return a native `continuation` checkpoint. For a bounded correction, send `action: "implement"`, `repair: true`, the new correction in `task`, and `continuation: {runId, expectedWorkspaceSnapshot}`. The runtime restores a private closed transcript into a fresh process/turn while the project writer lease is held. The original assignment is not replayed. Checkpoints are single-use, limited to three repair turns, and require matching task, plan, project, model, tools, runtime, and workspace. Reviewers use fresh independent sessions. Reload, changed workspace, cancelled/failed writers, or invalid transcripts require a fresh bounded writer; transcript continuation is deliberately limited to the current manager runtime.
