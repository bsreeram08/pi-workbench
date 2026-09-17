# Child instructions and skills

Workbench builds explicit context for each delegated child in [`agent-context.ts`](../agent-context.ts). Ambient extension and skill discovery stays disabled. Including an instruction or skill does not load extension code or grant additional tool access.

## Repository instructions

The loader reads `AGENTS.md` from the configured Pi agent directory, then from the delegated project root. It includes simple `@filename.md` references from those files, resolving them beside the referring file. `@RTK.md` also supports a fallback at `~/.codex/RTK.md`. References are not expanded recursively, and nested `AGENTS.md` files are not preloaded; children are instructed to check for them before editing nested directories.

Absent files are skipped. Existing instruction files must be readable regular files within the limit below; errors stop child launch. This rule also applies to supported referenced instruction files. Paths are resolved to their canonical targets and deduplicated, so a symlink to a valid regular file is supported.

## Optional skills

The original task and agent role select skill names through [`workflow-concepts.ts`](../workflow-concepts.ts). For each selected name, the loader searches in this order:

1. `<project>/.agents/skills/<name>/SKILL.md`
2. `<project>/.pi/skills/<name>/SKILL.md`
3. `<Pi agent directory>/skills/<name>/SKILL.md`
4. `~/.agents/skills/<name>/SKILL.md`

The default Pi agent directory is `~/.pi/agent`. A missing copy allows the search to continue. An unreadable, non-file, or oversized selected copy is omitted with a reason; the loader does not substitute a lower-priority copy after such an error. Skills that exceed the combined budget are also omitted. Supplied skills are included in full, without truncation.

| Context content | Limit in UTF-8 bytes | When exceeded |
| --- | ---: | --- |
| Each existing `AGENTS.md` or supported reference | 24,000 | Stop launch |
| Each optional `SKILL.md` | 32,000 | Omit that skill |
| Combined supplied skill contents | 64,000 | Omit skills that do not fit |

These are byte limits, not character or token limits. The combined limit covers skill contents, not repository instructions or the entire child prompt.

The child context includes source paths and a `Skills not supplied` summary with omission reasons. Missing optional guidance does not waive repository instructions or acceptance criteria. Children must not claim omitted skills were loaded or search beyond their delegated access to obtain them.

Implementation aliases, including `developer`, `fixer`, `integration-implementer`, and roles ending in `-implementation`, receive the implementer profile's selection. Other supported aliases map verification, architecture, and product roles to their corresponding workflow profiles.

## Specialist handoff

Children still receive an explicit prompt, not the parent transcript. After a specialist settles, the host stores its final text on the run (`final-text.md` beside the integrity-checked record).

The current Main Pi turn keeps the full returned text so it can synthesize. Later turns replace that dump in the model context with a host-issued pointer (`runId`, status, digest, excerpt). Session history and stored runs are unchanged. Reload a dump with `workbench_agent_status` `output=true`, or pass it to another child with `fromRuns`. Unknown run ids fail closed. Invented run ids are not evidence.

## Verification

```sh
rtk proxy bun test tests/agent-context.test.ts tests/agent-run-manager.test.ts tests/workflow-orchestration.test.ts tests/child-handoff.test.ts
```

These regressions cover complete skill contents, per-file and combined limits, invalid optional files, source precedence, strict repository-instruction failures, and child/workflow integration. For a live visual task and expected outcomes, see [Testing the harness](testing-harness.md). For launch errors, see [Troubleshooting](troubleshooting.md).
