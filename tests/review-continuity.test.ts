import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readReviewContinuity, summarizeReviewContinuity } from "../review-continuity.ts";
import { getWorkflowPaths, writeWorkflowRunArtifact } from "../workflow-state.ts";
import { reviewProtocolValid, planReviewsPass, codeReviewsPass } from "../workflow-prompts.ts";

test("finding IDs ignore numbering and whitespace but do not pretend differently worded claims are equivalent", () => {
  const first = summarizeReviewContinuity("a", "1. Missing fallback.\n<plan-verdict>REJECT</plan-verdict>");
  const second = summarizeReviewContinuity("a", "2.   Missing fallback.\n<plan-verdict>REJECT</plan-verdict>", first);
  expect(second.repeated).toEqual([first.observations[0].id]);
  expect(second.unchangedArtifact).toBe(true);
  expect(second.nextDecision).toContain("not proof");
  const changed = summarizeReviewContinuity("b", "A newly observed security issue.", second);
  expect(changed.repeated).toEqual([]);
  expect(changed.unchangedArtifact).toBe(false);
});

test("advisory continuity reloads bounded observations and ignores malformed or unsafe artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-continuity-"));
  const paths = getWorkflowPaths(path.join(root, ".pi/pi-workbench"));
  try {
    const summary = summarizeReviewContinuity("digest", "Check the actual context-loss behavior.");
    const artifact = await writeWorkflowRunArtifact(paths, "plan-1", "plan-continuity.md", JSON.stringify(summary));
    expect((await readReviewContinuity(paths, "plan-1", "plan"))?.observations).toEqual(summary.observations);
    await fs.writeFile(artifact, "malformed");
    expect(await readReviewContinuity(paths, "plan-1", "plan")).toBeUndefined();
    await fs.writeFile(artifact, "x".repeat(160_001));
    expect(await readReviewContinuity(paths, "plan-1", "plan")).toBeUndefined();
    await fs.unlink(artifact); await fs.symlink(path.join(root, "outside"), artifact);
    expect(await readReviewContinuity(paths, "plan-1", "plan")).toBeUndefined();
    expect(await readReviewContinuity(paths, "../outside", "plan")).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("protocol diagnostics distinguish rejection from malformed or contradictory output", () => {
  expect(reviewProtocolValid("<plan-verdict>REJECT</plan-verdict>", "plan")).toBe(true);
  expect(reviewProtocolValid("No verdict", "plan")).toBe(false);
  expect(reviewProtocolValid("<plan-verdict>OKAY</plan-verdict> trailing", "plan")).toBe(false);
  expect(reviewProtocolValid("<code-verdict>PASS</code-verdict>\n<code-verdict>BLOCKED</code-verdict>", "code")).toBe(false);
  expect(reviewProtocolValid("<code-verdict>BLOCKED</code-verdict>", "code")).toBe(true);
  for (const prefix of ["> ", "Findings: ", "`", "    > ", "    ", "\t", "```text\n", "~~~\n"]) {
    const output = `${prefix}<plan-verdict>OKAY</plan-verdict>`;
    expect(reviewProtocolValid(output, "plan")).toBe(false);
    expect(planReviewsPass([{ agentId: "technical-reviewer", title: "Review", output, exitCode: 0 }], 1)).toBe(false);
  }
  expect(reviewProtocolValid("Findings checked.\n  <plan-verdict>OKAY</plan-verdict>\n", "plan")).toBe(true);
  expect(reviewProtocolValid("```text\nExample only\n```\n<plan-verdict>OKAY</plan-verdict>", "plan")).toBe(true);
});

test("native review gates require distinct expected reviewer lanes, not duplicate completion counts", () => {
  const technical = { agentId: "technical-reviewer", title: "Technical", output: "<plan-verdict>OKAY</plan-verdict>", exitCode: 0 };
  expect(planReviewsPass([technical, technical])).toBe(false);
  expect(planReviewsPass([technical], 1)).toBe(true);
  expect(planReviewsPass([{ ...technical, agentId: "implementer" }], 1)).toBe(false);
  const quality = { ...technical, agentId: "quality-reviewer" };
  expect(planReviewsPass([technical, quality])).toBe(true);
  expect(codeReviewsPass([technical, technical].map(item => ({ ...item, output: "<code-verdict>PASS</code-verdict>" })))).toBe(false);
});
