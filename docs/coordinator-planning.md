# Coordinator planning and model selection

`/plan <task>` hands planning to Main Pi using the model already selected for that conversation. Main Pi inspects the project, explains major decisions, asks about real ambiguities, and delegates bounded advice where useful. There is no mandatory Explorer → Planner sequence.

Main Pi submits a complete plan with a terminal task packet to `workbench_plan` using `action: "review"`. Native reviewers inspect it independently. Their findings return to Main Pi, which decides how to revise within the configured review limit. A passing review enables `action: "approve"`; your interactive confirmation approves that exact draft.

`/start-work` confirms implementation and hands control to Main Pi too. It uses `workbench_execute` to assign bounded implementation with an explicit model, inspects actual changes and behavior, and directs corrections. `action: "verify"` runs independent code review and native verification, returning findings to Main Pi without automatic repair. `action: "complete"` records Main Pi's final assessment only when the passing native evidence still matches the workspace and workflow state. Models cannot supply their own completion ticket. Reload clears pending completion tickets, so avoid reloading between passing final checks and completion.

The required Coordinator assessment makes its reasoning reviewable; it is not mechanical proof that the model inspected well. Independent reviewers and observed checks remain separate gates. Reviewers use the configured focused/thorough count. An optional verify `model` selects code reviewers; the separate verification agent follows normal routing.

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

During an approved workflow, use `workbench_execute` with `action: "implement"`, `planId`, a bounded `task`, and `model: "openai-codex/gpt-6-astra:high"`. This path requires an explicit model choice and holds the writer lease. Each result returns to Main Pi for inspection. An override on one call does not rewrite later automatic lanes. `/start-work --pipeline` retains the automatic implementation/review/repair sequence for users who explicitly choose it.

## Verify the behavior

1. Reload Workbench while idle. In a scratch project, run `/plan Build a small page with a keyboard-accessible navigation menu`.
2. Confirm the activity row appears and Main Pi discusses decisions. Default planning should not immediately launch a mandatory Explorer/Planner chain.
3. Ask for Astra for UI/UX review. Inspect the route receipt: it should show `openai-codex/gpt-6-astra` with the requested thinking level. If unavailable, expect an error and no substitute child.
4. Submit the plan to native review. Rejections should return to Main Pi for correction. A passing review still requires your approval before `/start-work`.
5. Check that the activity row updates during delegation and clears when work ends.
6. Run `/start-work` and request Astra for UI implementation. Main Pi should describe the slice, call `workbench_execute` with Astra, inspect the returned changes, and direct review. Completion requires native gates plus a separate Main Pi assessment; rejection must not silently launch another implementer.

Automated coverage is in `tests/workflow-orchestration.test.ts`, `tests/routing.test.ts`, and `tests/workflow-activity.test.ts`. These tests establish control flow, model propagation, and UI lifecycle behavior; they do not establish that a particular model makes better design decisions.
