# Measuring harness quality

For commands and expected outcomes, see [Test the harness improvements](testing-harness.md).

The process tests prove properties of the harness. They do not establish that a model produces better finished work with it. Do not label fixture success rates as agent-quality improvements.

Default planning and execution now return decisions to Main Pi through native tools. Compare this Coordinator flow against explicit `/plan --pipeline` and `/start-work --pipeline` on the same tasks. Current regressions check exact model propagation, return of reviewer findings without automatic repair, and rejection of completion after workspace changes. A required Coordinator assessment records reasoning; evaluate whether it actually identifies defects and improves the finished result in live trials.

Compare four configurations on the same task snapshots: Main Pi alone; Main Pi with relevant context; focused Workbench; thorough Workbench. Fix the model, reasoning level, time/tool budget, repository starting point, and installed skill revisions. Run each task more than once and rotate configuration order. Keep evaluator tests outside the writer's editable checkout.

Use real completed tasks with known expected behavior: a regression with a reproducer, an API change with error cases, a UI interaction with visual/keyboard checks, a cross-file refactor, and a research question with primary-source support. Include dirty starting trees and interruption/recovery cases. Expand the set with actual failures; reserve unseen tasks for final comparison.

For each run, retain the configuration/revision, task snapshot, elapsed time, usage, patch, native check receipts, independent evaluation outcome, human corrections, and regressions. Blind human comparison should assess visual quality and maintainability where automated tests are insufficient. Report the distribution of outcomes, not only the best run.

Promote a new skill, extra agent stage, routing rule, or context layer only after comparison demonstrates improved outcomes on relevant tasks. The present change has mechanical regression coverage; no live-model superiority result is claimed.

## Receipt design decision

Inspected `bsreeram08/pi-intent-receipt` as inspiration. Its useful distinction is between the writer's statement and an observed process result. Workbench adopts that distinction within its existing execution path. It does not adopt the fixed Grok writer, default `bun test`, mandatory clean source tree, new installation dependency, or automatic patch copy-back.

Checks are selected from the repository and acceptance criteria. The runtime records execution and code identity; an independent reviewer assesses whether those checks actually support completion. This is intentionally narrower than claiming that any command returning zero proves the product correct.

## Research flow and remaining work

Target flow: decision → research questions → recorded source retrievals → supported claims → calculations → synthesis → independent claim audit → targeted corrections.

Implemented: parent-recorded retrieval artifacts, excerpt binding, UI-only user observations, canonical citation mapping, bibliography-separated numeric citation checks, persistent unresolved-source failures, failed/ambiguous-auditor rejection, counterevidence at fast depth, and quantitative analysis after collection. The parent re-fetches cited URLs and deduplicates successful retrievals within a run, adding latency and provider/site traffic in exchange for independently observed source material. Source snapshots contain bounded extracted text; excerpts outside that text remain unverified. Browser fallback is available for failed static extraction.

Legacy ledgers are not retroactively trusted. Use `/research-source` to retrieve and explicitly review an existing claim/excerpt, or resubmit a user observation, then re-synthesize and audit. Refresh alone does not re-baseline a claim or resolve an independent failure. Source artifacts are tamper-evident under the cooperative runtime model, not protected from arbitrary same-user code that can rewrite both evidence and metadata.

Still to implement: decision-specific question planning beyond fixed track templates, targeted correction loops, and claim-focused batching for large reports. Current oversized synthesis/audit inputs fail visibly; partial inputs cannot receive an unqualified PASS. Semantic support and source authority remain independent model-review responsibilities. A matching excerpt proves where text appeared, not that the claim is true.

Compare the old and revised flows on the same questions, for example an official API compatibility question, a competitor-pricing decision, and a quantitative scenario with conflicting source figures. Fix the as-of date, accessible source set, model, budget, and expected material claims. Score unsupported claims, incorrect citations, source coverage, useful conclusions, latency, and cost. Keep failure cases for invented provenance, uncited claims with a bibliography, stale sources, failed reviewers, and incomplete coverage in the regression suite. No live-model quality gain has been measured yet.
