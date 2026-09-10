# Plan 001: Require grounded finding envelopes on independent code review

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 5c0328d..HEAD -- workflow-prompts.ts workflow-task-packet.ts coordinator-execution.ts review-continuity.ts supervision-evidence.ts tests/review-continuity.test.ts tests/pi-workbench.test.ts tests/workflow-task-packet.test.ts tests/coordinator-execution-recovery.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `5c0328d`, 2026-09-10
- **Executed at**: `feat/canonical-review-findings` @ `8076cdb` (isolated worktree; not merged)

## Why this matters

Independent code review currently ends with Markdown plus a terminal `<code-verdict>`. `codeReviewsPass` treats a well-formed `PASS` as a native gate even when the prose invents paths, line numbers, or snippets. Continuity fingerprints paragraphs; it does not bind a finding to bytes in the leased tree.

This plan makes a missing, reordered, or ungrounded finding envelope a **protocol failure** (same class as a malformed task packet), not a `PASS` and not a product `CHANGES_REQUIRED`. Completing a workflow still requires inspect IDs, `workbench_verify`, and Main Pi's assessment. The envelope is navigation plus a host check that claimed snippets exist.

## Current state

- `workflow-prompts.ts` — `buildCodeReviewTask` (around 300–324) asks for `## Findings` in prose and a unique terminal `<code-verdict>`. `uniqueTerminalVerdict` (461–481) requires the verdict at end-of-output, not inside a fence, with no trailing text. `reviewProtocolValid` / `parseCodeVerdict` / `codeReviewsPass` (488–505) only look at that marker.
- `coordinator-execution.ts` (223–267) — `passed` requires `codeReviewsPass`. `protocolFailure` is true when checks pass but a review marker is missing. `summarizeReviewContinuity` hashes review paragraphs.
- `review-continuity.ts` (16–31) — splits on blank lines; IDs are `finding-<16 hex>` of normalized prose. Advisory only.
- `workflow-task-packet.ts` — **the codec pattern to copy**: exact key order, compact JSON, unique terminal marker, protocol-failure vs product failure. `evaluateWorkflowVerification` maps malformed envelopes to `result: "protocol-failure"`.
- `supervision-evidence.ts` (13–16, 85–88) — `within(root, file)` and `InspectionReceipt.files[].digest`. Reviewer children do **not** have `workbench_execute inspect`. Ground findings against **current files in `project.root`**, not inspect IDs.
- Tests: `tests/review-continuity.test.ts`, `tests/pi-workbench.test.ts` (~306–328), `tests/workflow-task-packet.test.ts` (marker/codec pattern), `tests/coordinator-execution-recovery.test.ts` (verify pass/reject/protocol).

Excerpt — review task today:

```315:324:workflow-prompts.ts
Form your own assessment from the request, acceptance criteria, code, and tests. The implementer's self-assessment is deliberately omitted. Inspect the real diff and run safe checks when useful. Findings must name severity, path, evidence, and concrete fix. Return:
## Verdict
## Findings
## Verification Gaps
## Evidence
End with exactly one marker:
<code-verdict>PASS</code-verdict>
```

Excerpt — pass predicate:

```230:237:coordinator-execution.ts
          const passed = before === after && checkEvidence?.snapshot === after
            && codeReviewsPass(reviews, project.config.workflowMode === "thorough" ? 2 : 1)
            && (packetVerification ? packetVerificationPasses(packetVerification) : legacyVerificationPasses(verification.output)
              && Boolean(checkEvidence.receipts.length && checkEvidence.receipts.every((receipt) => checkPassed(receipt, after))));
          const substantiveRejection = reviews.some((review) => reviewProtocolValid(review.output, "code") && parseCodeVerdict(review.output) !== "PASS");
          const protocolFailure = !substantiveRejection && before === after
            && Boolean(checkEvidence?.receipts.length && checkEvidence.snapshot === after && checkEvidence.receipts.every((receipt) => checkPassed(receipt, after)))
            && (reviews.some((review) => !reviewProtocolValid(review.output, "code")) || packetVerification?.result === "protocol-failure");
```

Conventions: fail closed; canonical compact JSON; no duplicate/reordered/unknown fields; host never treats model prose as proof. Match `workflow-task-packet.ts` and `tests/workflow-task-packet.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `bun test tests/workflow-findings.test.ts tests/review-continuity.test.ts tests/pi-workbench.test.ts tests/coordinator-execution-recovery.test.ts tests/workflow-task-packet.test.ts` | all pass |
| Typecheck | `bun run typecheck` | `strict TypeScript check passed` |
| Public + full | `bun run check` | public-release, all tests, typecheck |

## Suggested executor toolkit

- Read `workflow-task-packet.ts` and `tests/workflow-task-packet.test.ts` before writing the codec.
- Do not add native parsers, new npm packages, or inspect-ID requirements on children.

## Scope

**In scope**:
- `workflow-findings.ts` (create)
- `tests/workflow-findings.test.ts` (create)
- `workflow-prompts.ts` (`buildCodeReviewTask`, `reviewProtocolValid` for `"code"`, `codeReviewsPass`)
- `coordinator-execution.ts` (wire grounding into protocol failure)
- `tests/review-continuity.test.ts`, `tests/pi-workbench.test.ts`, `tests/coordinator-execution-recovery.test.ts` (update fixtures that emit only `<code-verdict>`)
- `docs/coordinator-planning.md`, `docs/troubleshooting.md`, `CHANGELOG.md` (Unreleased), `README.md` only if the verification paragraph is now wrong

**Out of scope**:
- Plan-review `<plan-verdict>` protocol
- `review-continuity.ts` ID scheme (keep advisory paragraph fingerprints)
- Giving children `workbench_execute`
- Impact graphs, tree-sitter, review-policy files, extra inspect rounds (plan 002+)
- Changing `workbench_verify` receipts or completion tickets
- Any mention of other products or CLIs in comments, docs, or tests

## Git workflow

- Branch: `feat/canonical-review-findings` (repo uses `feat/` / `fix/`)
- Commits: outcome-first subject, body names checks. Example: `Isolate updater test deadlines and stop CI timeout cascades`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the findings codec

Create `workflow-findings.ts` modeled on `workflow-task-packet.ts`.

Canonical marker (immediately **before** the unique terminal `<code-verdict>`, no text between them except a single newline):

```text
<workflow-findings>{"schemaVersion":1,"findings":[]}</workflow-findings>
<code-verdict>PASS</code-verdict>
```

JSON schema (exact key order, compact JSON, no extra fields):

```ts
{
  schemaVersion: 1,
  findings: Array<{
    id: string;                 // kebab-case, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, ≤64 bytes, unique in the array
    severity: "blocker" | "warning" | "note";
    path: string;               // project-relative, no `..`, no absolute, ≤500 bytes
    startLine: number;          // integer ≥ 1
    endLine: number;            // integer ≥ startLine
    evidenceDigest: string;     // `sha256:` + 64 lowercase hex
    summary: string;            // trimmed one line, ≤500 bytes
  }>;                           // 0–32 entries
}
```

Export:

- `WORKFLOW_FINDINGS_OPEN` / `CLOSE` constants
- `parseWorkflowFindings(output: string): WorkflowFindings | undefined` — unique pair of tags in the whole output; payload canonical; returns undefined if missing/malformed
- `canonicalWorkflowFindingsMarker(value)`
- `groundWorkflowFindings(root: string, findings: WorkflowFindings): Promise<{ ok: true } | { ok: false; reason: string }>`:
  - resolve each `path` with the same `within(root, file)` rule as `supervision-evidence.ts`
  - read the file (regular file only, `O_NOFOLLOW` if you open fds; follow the style in `review-continuity.ts`)
  - take lines `startLine..endLine` (1-based, inclusive) joined with `\n` (no trailing extra newline beyond the last selected line's original terminator — hash the exact slice `lines.slice(start-1, end).join("\n")`)
  - digest = `sha256:` + sha256 hex of that UTF-8 slice
  - fail if file missing, not a file, path escapes, line range past EOF, or digest mismatch
- `codeReviewEnvelopeValid(output: string): boolean` — `parseWorkflowFindings` succeeds **and** `reviewProtocolValid(output, "code")` would succeed on the same string (verdict still last)

Contradiction rules (host, not the model):

- `PASS` with any `blocker` or `warning` finding → envelope invalid (notes-only is allowed on PASS)
- `CHANGES_REQUIRED` or `BLOCKED` with empty `findings` → envelope invalid
- Duplicate `id` → invalid

**Verify**: `bun test tests/workflow-findings.test.ts` → file exists and codec tests pass once written in step 2. After step 1, `bun run typecheck` still passes if the module is unused; prefer adding the test file in the same step.

### Step 2: Tests for the codec and grounding

Create `tests/workflow-findings.test.ts` modeled on `tests/workflow-task-packet.test.ts`.

Cases:

1. Empty findings + `PASS` parses.
2. One grounded finding: write a temp file `src/example.ts` with known lines; digest matches; `groundWorkflowFindings` ok.
3. Digest mismatch → not ok.
4. `../secret` path → not ok.
5. Reordered JSON keys / extra field / duplicate id → parse undefined.
6. Verdict with no findings marker → `codeReviewEnvelopeValid` false.
7. Findings marker after verdict → invalid (verdict must remain last; `uniqueTerminalVerdict` still requires no trailing text).
8. `PASS` + blocker finding → invalid.
9. `CHANGES_REQUIRED` + empty findings → invalid.
10. Marker inside a fenced code block does not count (copy the fence logic from `uniqueTerminalVerdict` or require the findings marker to be the last `<workflow-findings>` pair immediately above the verdict line).

**Verify**: `bun test tests/workflow-findings.test.ts` → all pass.

### Step 3: Require the envelope in the review prompt and pass predicates

In `buildCodeReviewTask`, keep the Markdown sections, then replace the ending with: emit the canonical `<workflow-findings>` marker then exactly one `<code-verdict>`. Spell the JSON rules the same way `WORKFLOW_PLAN_FORMAT` spells packet rules. Tell the reviewer: quote a contiguous line range from a project file; the host will hash those lines.

Change `reviewProtocolValid(output, "code")` to also require a valid findings envelope (so missing envelope is protocol-invalid, not `CHANGES_REQUIRED` via `parseCodeVerdict` fallback).

Keep `parseCodeVerdict` as today for the verdict value. `codeReviewsPass` already uses `reviewProtocolValid` indirectly? Check: it uses `parseCodeVerdict === "PASS"` and does **not** call `reviewProtocolValid`. Update `codeReviewsPass` so every result must `reviewProtocolValid(output, "code")` **and** `parseCodeVerdict === "PASS"`. That way a `PASS` verdict without envelope does not pass the gate.

Wire `coordinator-execution.ts` so `protocolFailure` includes grounded-findings failure:

- After reviews return, for each review with a valid envelope, `await groundWorkflowFindings(project.root, parsed)`.
- If envelope missing/malformed **or** grounding fails, treat like today's missing `<code-verdict>`: `protocolFailure` (not product rejection), `verification_protocol_invalid`, do not launch a fixer.

**Verify**: `bun test tests/workflow-findings.test.ts tests/review-continuity.test.ts tests/pi-workbench.test.ts tests/coordinator-execution-recovery.test.ts`

Expect existing fixtures that only emit `<code-verdict>PASS</code-verdict>` to fail. Update those fixtures to:

```text
<workflow-findings>{"schemaVersion":1,"findings":[]}</workflow-findings>
<code-verdict>PASS</code-verdict>
```

For rejection fixtures, include at least one finding whose path exists in the test fixture tree **or** assert protocol-invalid when the path does not exist. Prefer creating a tiny file in the existing coordinator fixture root and a matching digest so product `CHANGES_REQUIRED` still works.

**Verify**: the same bun test command, all pass.

### Step 4: Docs

Update `docs/coordinator-planning.md` (code review / inspect-and-decide) and `docs/troubleshooting.md` if it describes review markers: independent code review requires the findings marker; ungrounded snippets are protocol failures; recover once, do not rewrite product code to fix protocol.

One Unreleased `CHANGELOG.md` bullet. Do not mention other tools.

**Verify**: `rg -n "code-verdict" docs/coordinator-planning.md docs/troubleshooting.md README.md` — any user-facing description of independent code review also mentions `<workflow-findings>`.

## Test plan

- New: `tests/workflow-findings.test.ts` (cases in step 2).
- Update: `tests/review-continuity.test.ts`, `tests/pi-workbench.test.ts` (`parseCodeVerdict` / `codeReviewsPass` / `reviewProtocolValid` code cases), `tests/coordinator-execution-recovery.test.ts` (passing reviews must include the empty envelope; one test that a `PASS` without envelope is `verification_protocol_invalid`).
- Pattern: `tests/workflow-task-packet.test.ts` and `tests/review-continuity.test.ts`.
- Verification: `bun test tests/workflow-findings.test.ts tests/review-continuity.test.ts tests/pi-workbench.test.ts tests/coordinator-execution-recovery.test.ts tests/workflow-task-packet.test.ts` → all pass.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] Focused tests above pass; new tests exist for parse, grounding, PASS+blocker, missing envelope
- [ ] `codeReviewsPass` cannot return true for output that is only `<code-verdict>PASS</code-verdict>`
- [ ] No files outside the in-scope list (`git status`)
- [ ] `plans/README.md` status row for 001 updated
- [ ] Comments/docs/changelog do not name any external review CLI

## STOP conditions

- Drift: `uniqueTerminalVerdict` / `codeReviewsPass` / coordinator verify predicate no longer match the excerpts.
- Grounding appears to need child access to `workbench_execute` — do not add that; stay on `project.root` file bytes.
- You feel you must add tree-sitter, a second reviewer model, or fail-open ("keep the review if grounding throws").
- A coordinator fixture has no real files to ground against and the only way forward is skipping grounding in production code.

## Maintenance notes

- Plan 002 will inject a host impact receipt into `buildCodeReviewTask`. Keep the findings codec independent of graphs.
- Reviewers of the PR should confirm protocol failure vs product rejection stays distinct (`verification_protocol_invalid` vs `changes_required`).
- Deferred: plan-review envelopes; binding findings to inspect receipt IDs; glob review-policy files.
