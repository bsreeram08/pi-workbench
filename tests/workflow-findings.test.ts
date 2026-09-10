import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  canonicalWorkflowFindingsMarker,
  codeReviewEnvelopeValid,
  groundWorkflowFindings,
  parseWorkflowFindings,
  type WorkflowFinding,
  type WorkflowFindings,
} from "../workflow-findings.ts";

const empty: WorkflowFindings = { schemaVersion: 1, findings: [] };

function digestSlice(text: string, startLine: number, endLine: number): string {
  const slice = text.split("\n").slice(startLine - 1, endLine).join("\n");
  return `sha256:${createHash("sha256").update(slice, "utf8").digest("hex")}`;
}

function finding(overrides: Partial<WorkflowFinding> = {}): WorkflowFinding {
  return {
    id: "missing-fallback",
    severity: "blocker",
    path: "src/example.ts",
    startLine: 1,
    endLine: 2,
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    summary: "Missing fallback on the documented error path.",
    ...overrides,
  };
}

function envelope(value: WorkflowFindings, verdict: string): string {
  return `${canonicalWorkflowFindingsMarker(value)}\n<code-verdict>${verdict}</code-verdict>`;
}

describe("workflow findings codec", () => {
  test("parses empty findings immediately before a terminal PASS", () => {
    const output = envelope(empty, "PASS");
    expect(parseWorkflowFindings(output)).toEqual(empty);
    expect(codeReviewEnvelopeValid(output)).toBe(true);
  });

  test("rejects reordered keys, extra fields, and duplicate ids", () => {
    const item = finding();
    const candidates = [
      `<workflow-findings>${JSON.stringify({ findings: [], schemaVersion: 1 })}</workflow-findings>\n<code-verdict>PASS</code-verdict>`,
      `<workflow-findings>${JSON.stringify({ schemaVersion: 1, findings: [], unknown: true })}</workflow-findings>\n<code-verdict>PASS</code-verdict>`,
      `<workflow-findings>${JSON.stringify({ schemaVersion: 1, findings: [item, { ...item }] })}</workflow-findings>\n<code-verdict>CHANGES_REQUIRED</code-verdict>`,
      canonicalWorkflowFindingsMarker({ schemaVersion: 1, findings: [item] }).replace('"id":', '"unknown":"x","id":') + "\n<code-verdict>CHANGES_REQUIRED</code-verdict>",
      canonicalWorkflowFindingsMarker(empty).replace(":1,", ": 1,") + "\n<code-verdict>PASS</code-verdict>",
    ];
    for (const candidate of candidates) {
      expect(parseWorkflowFindings(candidate)).toBeUndefined();
      expect(codeReviewEnvelopeValid(candidate)).toBe(false);
    }
  });

  test("PASS with a blocker finding is an invalid envelope", () => {
    const output = envelope({ schemaVersion: 1, findings: [finding()] }, "PASS");
    expect(parseWorkflowFindings(output)?.findings).toHaveLength(1);
    expect(codeReviewEnvelopeValid(output)).toBe(false);
  });

  test("CHANGES_REQUIRED with empty findings is an invalid envelope", () => {
    const output = envelope(empty, "CHANGES_REQUIRED");
    expect(parseWorkflowFindings(output)).toEqual(empty);
    expect(codeReviewEnvelopeValid(output)).toBe(false);
  });

  test("verdict without a findings marker is not a valid envelope", () => {
    expect(parseWorkflowFindings("<code-verdict>PASS</code-verdict>")).toBeUndefined();
    expect(codeReviewEnvelopeValid("<code-verdict>PASS</code-verdict>")).toBe(false);
  });

  test("findings marker after the verdict is invalid because the verdict must remain last", () => {
    const output = `<code-verdict>PASS</code-verdict>\n${canonicalWorkflowFindingsMarker(empty)}`;
    expect(codeReviewEnvelopeValid(output)).toBe(false);
  });

  test("marker inside a fenced code block does not count", () => {
    const marker = canonicalWorkflowFindingsMarker(empty);
    expect(codeReviewEnvelopeValid(`\`\`\`\n${marker}\n\`\`\`\n<code-verdict>PASS</code-verdict>`)).toBe(false);
    expect(codeReviewEnvelopeValid(`\`\`\`\n${marker}\n<code-verdict>PASS</code-verdict>\n\`\`\``)).toBe(false);
    expect(parseWorkflowFindings(`\`\`\`\n${marker}\n\`\`\`\n<code-verdict>PASS</code-verdict>`)).toBeUndefined();
  });
});

describe("workflow findings grounding", () => {
  test("accepts one finding whose digest matches current project file bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-findings-"));
    try {
      const text = "const a = 1;\nconst b = 2;\nconst c = 3;";
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src/example.ts"), text);
      const value: WorkflowFindings = {
        schemaVersion: 1,
        findings: [finding({ evidenceDigest: digestSlice(text, 1, 2) })],
      };
      expect(codeReviewEnvelopeValid(envelope(value, "CHANGES_REQUIRED"))).toBe(true);
      expect(await groundWorkflowFindings(root, value)).toEqual({ ok: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a digest that does not match the selected lines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-findings-"));
    try {
      await fs.mkdir(path.join(root, "src"));
      await fs.writeFile(path.join(root, "src/example.ts"), "const a = 1;\nconst b = 2;");
      const value: WorkflowFindings = { schemaVersion: 1, findings: [finding()] };
      expect(await groundWorkflowFindings(root, value)).toEqual({ ok: false, reason: "digest-mismatch" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a path that escapes the project root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-findings-"));
    try {
      const value = {
        schemaVersion: 1 as const,
        findings: [finding({ path: "../secret" })],
      };
      expect(parseWorkflowFindings(`<workflow-findings>${JSON.stringify(value)}</workflow-findings>`)).toBeUndefined();
      expect(await groundWorkflowFindings(root, value)).toEqual({ ok: false, reason: "invalid-payload" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
