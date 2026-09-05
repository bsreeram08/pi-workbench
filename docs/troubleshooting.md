# Workflow troubleshooting

Start with the latest error and `/workflow-status`. Earlier chat messages describe earlier attempts; they do not prove that a lock still exists or that the current extension is loaded. Review logs before sharing them, since paths, task text, and command output can contain private data.

## Writer unavailable while an update marker exists

```text
Project writer lease is unavailable while a Workbench update marker exists.
```

The update marker coordinates all projects using the same Pi agent directory. By default it is `~/.pi/agent/update/pi-workbench/update.lock`; a custom `PI_CODING_AGENT_DIR` changes that location. An update in one checkout can therefore block new workflow writers in another project.

If an update is running, let it finish before retrying. Workbench deliberately does not take over existing markers, including stale or malformed ones. Age alone does not establish that a marker is stale, and restarting Pi does not remove it.

An operator investigating a leftover marker must inspect its recorded hostname, PID, process-start identity, and update recovery state. A live owner or ambiguous identity must be resolved before recovery. Confirmed stale-marker recovery should preserve the marker and recovery artifacts, use the same coordination gate, and revalidate the exact marker before moving it aside. There is no automatic force-unlock command; avoid deleting lock files blindly. See the [coordination implementation](../exclusive-lease.ts) and [updater trust model](../SECURITY.md).

## Planning stops on a valid design skill

Older loaders reported this for optional skills larger than 24,000 bytes:

```text
Instruction file is not a bounded regular file: .../emil-design-eng/SKILL.md
```

The current loader allows 32,000 bytes per optional skill and 64,000 bytes across supplied skills. A valid skill between 24,000 and 32,000 bytes can now load in full. Unavailable optional skills are reported and omitted instead of aborting planning. Do not shorten a valid installed skill just to work around the old loader.

After updating the checkout, run `/reload` in an existing Pi session, then retry `/plan`. If the old message persists, confirm which Workbench checkout Pi actually loads and its Git revision. A fixed file on disk does not prove an existing session has loaded it.

Current `Context file exceeds 24000 bytes` or `Context file is not a regular file` errors on repository instructions still stop launch. Inspect the named `AGENTS.md` or referenced file and correct the actual file problem. The optional-skill fix does not bypass required instructions. See [Child instructions and skills](child-context.md) for limits and source precedence.

## A selected skill was omitted

`Skills not supplied` in child context reports missing files, read failures, invalid file kinds, or budget limits. It is not by itself a workflow failure. Inspect the reported source and reason if that guidance is needed. A faulty higher-priority copy prevents fallback to another copy; correct that source before retrying. Workbench does not install missing skills during launch.

## Project trust or model selection looks wrong

For an untrusted project, run `/trust` and restart Pi before launching children. Reloading an extension is separate from restarting after a new project-trust decision.

The Main Pi model and child routing are separate settings. Seeing Main Pi use Astra while Codebase Explorer uses Terra can be expected. Inspect `/model-routing` for the child family and policy; changing them does not change Main Pi's model. See [Child model routing](../README.md#child-model-routing).

If you explicitly requested Astra for a particular task, Main Pi should pass `model: "openai-codex/gpt-6-astra:high"` on that delegation or native review call. `workbench_execute` requires an explicit model for implementation. An unavailable exact model fails without substitution. A previous Astra review does not by itself change the model used for a later implementation call.

## Main Pi disappears during implementation

Default `/plan` and `/start-work` now hand control to Main Pi. It chooses bounded assignments and models, inspects actual changes, and resolves independent findings. Native `workbench_plan` and `workbench_execute` retain approval and verification gates. The automatic sequence remains available through explicit `--pipeline` commands and `/autopilot`.

Reload while idle to load these tool changes. Reload does not transform a pipeline already running or resume an interrupted execution. Inspect `/workflow-status` before starting anything new. During active Coordinator work, the activity row shows the phase and elapsed time; each child result should return to Main Pi for assessment. See [Coordinator planning and execution](coordinator-planning.md) for examples and tests.

## Retrying after an interrupted plan

If the attempt says `No implementation was started`, resolve the launch error and retry `/plan`. Review the resulting plan and acceptance criteria before `/start-work`. If execution had already begun, inspect `/workflow-status` and the working tree first; Workbench does not automatically resume interrupted work.

Use the disposable examples in [Testing the harness](testing-harness.md) to separate loader or receipt failures from problems in your actual project. If the issue remains, include the details listed in [Support](../SUPPORT.md).
