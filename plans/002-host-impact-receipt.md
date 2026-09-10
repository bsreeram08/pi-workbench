# Plan 002: Host impact receipt after each writer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5c0328d..HEAD -- coordinator-execution.ts workflow-prompts.ts supervision-evidence.ts verification.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 001 may already have landed;
> that is expected. Re-read `buildCodeReviewTask` and the implement handoff if they differ.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: plans/001-canonical-review-findings.md
- **Category**: direction
- **Planned at**: commit `5c0328d`, 2026-09-10
- **Executed at**: `feat/host-impact-receipt` @ `279085b` (isolated worktree; stacked on 001)

## Why this matters

After implementation, native handoff lists changed paths and content hashes (`captureSupervisionInventory` / `compareSupervisionInventories`). Independent review is still told in prose to "inspect the real diff." Fingerprints prove the tree did not move; they do not say which exports a hunk touched or which files import those modules. Reviewers invent blast radius. Completing against an empty main tree while work sits in a nested checkout is easier when the host never names dependents.

This plan adds a **host-authored impact receipt**: changed entities (hunk ∩ simple TS/JS exports), import-graph dependents to depth 3, a coarse blast-radius label, and a non-blocking list of changed files with no importing test file. The receipt is navigation. `unavailable` is allowed when parse cannot run. It must not become a completion ticket.

## Current state

- `coordinator-execution.ts` (162–183) — after `deps.implement`, host writes `handoff-<assignmentId>.md` with `changes` from inventory compare. Next instruction: Main Pi must inspect. No graph.
- `supervision-evidence.ts` (21–83) — inventory is path + digest (+ optional deletion). `within()` confines paths to `project.root`.
- `verification.ts` `workspaceSnapshot` — `git ls-files --cached --others --exclude-standard` then hash. Gitignored `.worktrees/` will not appear. Do not "fix" that here; the receipt only walks files the inventory already observed **or** `.ts/.tsx/.js/.jsx` under `project.root` that `within()` allows and that are not ignored by the same git listing you already use. If a path is not in the inventory and not git-listed, skip it.
- `workflow-prompts.ts` `buildCodeReviewTask` — no host map. Plan 001 adds a findings envelope; this plan only **prepends** a labeled impact block to that task string.
- `package.json` — no parser library. **Do not add tree-sitter or other native addons.**

Implementer handoff excerpt:

```172:183:coordinator-execution.ts
          const changes = compareSupervisionInventories(before, await captureSupervisionInventory(project.root));
          const handoff = {
            assignmentId, planId: state.id, runId: implementation?.runId ?? null, requestedModel: model, resolvedRoute: implementation?.routing ?? null,
            ...
            changes,
            ...
            next: "Main Pi must inspect actual source with the inspect action, check behavior, then decide to accept, repair, or escalate. These observations do not establish authorship or correctness.",
          };
```

Conventions: fail closed on path escape; advisory artifacts never authorize complete; JSON in `.pi/pi-workbench/workflow/runs/<planId>/` via `writeWorkflowRunArtifact`. Match existing run-artifact writes in `coordinator-execution.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `bun test tests/impact-receipt.test.ts tests/coordinator-execution-recovery.test.ts tests/workflow-findings.test.ts` | all pass |
| Typecheck | `bun run typecheck` | passed |
| Full | `bun run check` | passed |

## Suggested executor toolkit

- Read plan 001's `buildCodeReviewTask` ending so the impact block does not break the findings marker / verdict order.
- Do not add dependencies.

## Scope

**In scope**:
- `impact-receipt.ts` (create)
- `tests/impact-receipt.test.ts` (create)
- `coordinator-execution.ts` (compute after implement; persist artifact; pass into verify task builder)
- `workflow-prompts.ts` (`buildCodeReviewTask` extra argument: optional receipt text)
- `workflow.ts` only if `deps.verify` / `buildCodeReviewTask` call sites need the extra argument
- `docs/coordinator-planning.md`, `docs/troubleshooting.md`, `CHANGELOG.md` Unreleased
- Tests that construct `buildCodeReviewTask` (`tests/workflow-task-packet.test.ts` if it snapshots the prompt)

**Out of scope**:
- Native grammars / new packages
- Treating missing tests as a failed `workbench_verify` criterion
- Completing against `.worktrees/` (gitignore/fingerprint issue stays)
- Review-policy files, symbol-slice inspect, hash-skip of reviewer work, packing multiple reviewer processes
- Changing findings grounding from plan 001
- Comments that name other products

## Git workflow

- Branch: `feat/host-impact-receipt` (or continue 001's branch if stacking)
- Commit style: outcome-first, as in plan 001
- Do NOT push or open a PR unless asked

## Steps

### Step 1: Receipt types and TS/JS import scanner

Create `impact-receipt.ts`.

```ts
export type ImpactReceiptStatus = "available" | "unavailable";
export type BlastRadiusLevel = "low" | "medium" | "high" | "critical";

export interface ImpactEntity {
  path: string;
  name: string;
  kind: "function" | "class" | "variable" | "type" | "unknown";
  change: "added" | "modified" | "unchanged";
  startLine: number;
  endLine: number;
}

export interface ImpactReceipt {
  version: 1;
  status: ImpactReceiptStatus;
  reason?: string;          // required when unavailable
  snapshot: string;         // workspaceSnapshot hex
  changedPaths: string[];
  entities: ImpactEntity[];
  dependents: Array<{ path: string; depth: number }>;
  blastRadius: { level: BlastRadiusLevel; criticalPaths: string[] };
  untestedChangedFiles: string[];  // advisory
}
```

Scanner v1 (stdlib only):

- Only `.ts`, `.tsx`, `.js`, `.jsx`.
- Extract static imports: `from '...'`, `from "..."`, `import('...')`, `require('...')` where the specifier is a relative path (starts with `.`).
- Resolve relative specifiers against the importing file, try extensions `.ts/.tsx/.js/.jsx` and `/index` of those. Skip node_modules and anything failing `within(root, target)`.
- Extract exported names with a conservative regex: `export (async )?function Name`, `export class Name`, `export (const|let|var|type|interface|enum) Name`, `export { Name`, `export default function Name`. Line numbers from the match index.
- If a file cannot be read, omit it; do not fail the whole receipt unless **zero** changed TS/JS files could be opened when the inventory listed some — then `status: "unavailable"`, `reason: "no-parseable-sources"`.

Hunk ∩ entity:

- Input: unified diff **or**, if you do not want to shell out, the changed file's current text plus the inventory "before" digest. Preferred: `git diff` / stored before-content is **not** in inventory (inventory has hashes only).
- Practical v1: mark every export in a **changed** file as `modified` (or `added` if the path is new in the inventory compare). Do **not** claim hunk-accurate entity diffs unless you also persist before-bytes. STOP if you start storing full file copies of the whole repo. Optional later: `git show` is out of scope; stay on current tree + change list.

Dependents: reverse import graph BFS from changed files, `maxDepth = 3`, cap 200 nodes. `depth` 1 = direct importer.

Blast radius:

- `low`: no dependents
- `medium`: 1–2 unique dependent files
- `high`: 3–8
- `critical`: ≥9 **or** any dependent path contains `security`, `auth`, `payment`, `crypto` as a path segment (case-insensitive) — this is a **label only**
- `criticalPaths`: dependents with ≥3 inbound edges from the changed set, max 16 paths

`untestedChangedFiles`: changed non-test files (`*.test.*`, `*.spec.*`, `__tests__`, `/tests/` do not count as "code under test") that have **no** dependent whose path looks like a test file. Advisory. Never fail verify because this list is non-empty.

`buildImpactReceipt({ root, snapshot, changes })`: `changes` from `compareSupervisionInventories`. If `changes.status !== "available"`, return unavailable. If no changed paths, available with empty arrays, `blastRadius.level = "low"`.

**Verify**: `bun test tests/impact-receipt.test.ts` after step 2.

### Step 2: Unit tests for the scanner

Fixture a temp dir:

```
src/a.ts          export function foo() {}
src/b.ts          import { foo } from "./a"; export function bar() {}
src/b.test.ts     import { bar } from "./b";
```

Mark `src/a.ts` changed.

Expect: `foo` in entities; `src/b.ts` depth 1 dependent; `src/b.test.ts` may appear as dependent; `untestedChangedFiles` empty because a test file imports through `b` **or** still lists `a` if you only count **direct** test importers — **pick direct test importers of the changed file or of any dependent within depth 3**. Document the choice in the test name. Recommended: a changed file is "tested" if any test file appears in its dependent set within depth 3.

Second fixture: `src/c.ts` changed, no importers → `untestedChangedFiles` includes `src/c.ts`, blast `low`.

Third: path `../out.ts` import is ignored.

Fourth: only `.md` changed → available, empty entities, no crash.

**Verify**: `bun test tests/impact-receipt.test.ts` → all pass.

### Step 3: Persist and inject

In `coordinator-execution.ts` after `changes` is computed:

- `const snapshot = await workspaceSnapshot(project.root)`
- `const impact = await buildImpactReceipt({ root: project.root, snapshot, changes })`
- Write `impact-<assignmentId>.md` as `JSON.stringify(impact, null, 2)` via `writeWorkflowRunArtifact` (same as handoff)
- Include `impact` (or `impactArtifact`) on the handoff object
- Cache: if a previous `impact-*.md` for this planId has the same `snapshot` and the same sorted `changedPaths`, reuse it. Do not invent a new store.

Thread `impact` into `deps.verify` / `buildCodeReviewTask`.

`buildCodeReviewTask(..., impact?: ImpactReceipt)` prepends (before USER TASK):

```
HOST IMPACT RECEIPT (navigation only; not proof of correctness or completion):
```

then compact JSON of the receipt (cap 32 KiB; if larger, omit `dependents` beyond 50 entries and say truncated). If `unavailable`, print status + reason only.

Reviewers must not cite the receipt as evidence in `evidenceDigest`. Plan 001 grounding still hashes **file line ranges**.

**Verify**: `bun test tests/coordinator-execution-recovery.test.ts tests/impact-receipt.test.ts tests/workflow-findings.test.ts`

Add one coordinator-level assertion: after a successful implement in the existing fixture, an `impact-*.md` artifact exists and `buildCodeReviewTask` output contains `HOST IMPACT RECEIPT`. If the recovery tests do not make it easy to read the review prompt, unit-test `buildCodeReviewTask` with a fake receipt instead — do not destabilize recovery tests.

### Step 4: Docs

`docs/coordinator-planning.md`: after implement, host writes an impact receipt; reviewers use it as a map; completion still needs inspect + verify. Unavailable parse does not block.

`docs/troubleshooting.md`: if review misses a coupled file, check the receipt's `dependents`; if status is unavailable, inspect manually.

`CHANGELOG.md` Unreleased: one bullet. No extra product name.

**Verify**: `rg -n "impact receipt|HOST IMPACT" docs/coordinator-planning.md docs/troubleshooting.md CHANGELOG.md`

## Test plan

- `tests/impact-receipt.test.ts` — graph, blast, untested list, skip-list for non-JS, path escape.
- Prompt unit test: `buildCodeReviewTask` includes the block and still ends with `<workflow-findings>` then `<code-verdict>` (plan 001).
- Do not require tree-sitter in CI.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `bun test tests/impact-receipt.test.ts` passes
- [ ] `package.json` / `bun.lock` have no new parser package
- [ ] Impact receipt is not read by `complete` / ticket logic (`rg "buildImpactReceipt|ImpactReceipt" coordinator-execution.ts` — used in implement + review task only)
- [ ] `untestedChangedFiles` is not consulted by `packetVerificationPasses` or `checkPassed`
- [ ] `plans/README.md` row 002 updated
- [ ] No external-tool names in comments or docs

## STOP conditions

- Plan 001 is not on the branch and `buildCodeReviewTask` still has only a verdict marker — rebase/stack 001 first; do not invent a second review protocol.
- You believe you must add `tree-sitter` (or any native addon) to parse TS. Stay on regex/stdlib; mark other languages unavailable.
- Inventory compare no longer exists or `within` changed.
- Completing a workflow starts depending on `blastRadius.level`.

## Maintenance notes

- Follow-ups (not this plan): hunk-accurate entity diffs, glob review-policy files, extra inspect symbol slices, host packing of huge reviews, hash-skip of unchanged reviewer files.
- PR review: confirm the receipt cannot authorize `complete`; confirm `.worktrees/` gitignore still means those files are absent from inventory — do not "fix" that by walking ignored trees here.
