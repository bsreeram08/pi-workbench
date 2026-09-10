# Implementation Plans

Generated 2026-09-10 against `5c0328d`. Execute in the order below unless dependencies say otherwise. Each executor: read the plan fully before starting, honor its STOP conditions, and update your row when done.

Keep comments, tests, and docs Workbench-only. Do not cite other review products.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001  | Require grounded finding envelopes on independent code review | P1 | M | — | DONE |
| 002  | Host impact receipt after each writer | P1 | L | 001 | DONE |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (with one-line reason) | REJECTED (with one-line rationale)

## Dependency notes

- 002 prepends a host impact block onto `buildCodeReviewTask`. Plan 001 owns the terminal `<workflow-findings>` + `<code-verdict>` protocol. Land 001 first so 002 does not invent a second envelope.

## Findings considered and not planned this round

- Installer/README still advertising Codex Sol after the Grok default (`install.sh` usage, `README.md` `--full` paragraph): copy fix, separate from review gates.
- Read-only bash `git worktree add` vs blocked `mkdir`: harness nit; not the review protocol.
- Silent `setModel` when the registry misses the family model: notify-only; parked on Pi login.
- Child `PI_CODING_AGENT_DIR` bash exfil: security follow-up, not review.
- Unsandboxed child `qmd_search` `-c`: security follow-up.
- Durable routing config write without symlink checks: use `ensureProjectState` in a routing PR.
- Council `/tmp` worktrees and persistent mutation agents: blocked on a real in-project worktree host, not these two plans.
- Extra validator/consolidator models, persona renderers, durable review databases: rejected. Host schema + grounding + impact map are the gates.
- Graph-derived test gaps as a hard verify fail: rejected; 002 lists them as notes only.
- Native tree-sitter / new parser packages in 002: rejected; stdlib TS/JS scan only.

## How to run

```bash
# 001
bun test tests/workflow-findings.test.ts tests/review-continuity.test.ts tests/pi-workbench.test.ts tests/coordinator-execution-recovery.test.ts
bun run typecheck

# 002 (after 001)
bun test tests/impact-receipt.test.ts tests/coordinator-execution-recovery.test.ts tests/workflow-findings.test.ts
bun run check
```
