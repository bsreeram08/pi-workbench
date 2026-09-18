import { describe, expect, test } from "bun:test";
import { observedChecks } from "./fixtures/check-evidence.ts";
import {
  buildCodeReviewTask,
  buildExecutionBriefTask,
  buildFixTask,
  buildImplementationTask,
  buildPacketVerificationTask,
} from "../workflow-prompts.ts";
import {
  bindWorkflowTaskPacket,
  canonicalWorkflowTaskPacketMarker,
  evaluateWorkflowVerification,
  formatWorkflowTaskPacket,
  formatWorkflowVerificationFailures,
  parseWorkflowTaskPacket,
  packetVerificationPasses,
  validateWorkflowTaskPacket,
  visualPacketHasRequiredEvidence,
  type WorkflowTaskPacketDeclaration,
} from "../workflow-task-packet.ts";

const declaration: WorkflowTaskPacketDeclaration = {
  schemaVersion: 1,
  scope: ["Add packet-aware workflow verification."],
  nonGoals: ["Do not execute packet-authored commands."],
  acceptanceCriteria: [
    {
      id: "packet-codec",
      description: "Canonical task packets are validated and bound to the approved plan.",
      requiredEvidenceKinds: ["automated-test", "static-analysis"],
    },
    {
      id: "legacy-compatibility",
      description: "Packetless version 1 workflow state remains executable.",
      requiredEvidenceKinds: ["automated-test"],
    },
  ],
};

function planWith(marker = canonicalWorkflowTaskPacketMarker(declaration)): string {
  return `# Plan\n\nImplement the approved scope.\n\n${marker}`;
}

function verificationPayload(packet = bindWorkflowTaskPacket(planWith())): string {
  return JSON.stringify({
    schemaVersion: 1,
    packetId: packet.packetId,
    planDigest: packet.planDigest,
    criteria: [
      {
        criterionId: "packet-codec",
        status: "passed",
        evidence: [
          { kind: "automated-test", summary: "Focused packet codec tests passed." },
          { kind: "static-analysis", summary: "Strict TypeScript validation passed." },
        ],
      },
      {
        criterionId: "legacy-compatibility",
        status: "passed",
        evidence: [{ kind: "automated-test", summary: "Legacy workflow regression test passed." }],
      },
    ],
  });
}

function verificationOutput(payload = verificationPayload()): string {
  return `<workflow-verification>${payload}</workflow-verification>`;
}

describe("workflow task packet declaration codec", () => {
  test("parses one canonical terminal declaration and binds it to the complete trimmed plan", () => {
    const plan = planWith();
    expect(parseWorkflowTaskPacket(plan)).toEqual(declaration);
    const packet = bindWorkflowTaskPacket(`\n${plan}\n`);
    expect(packet.packetId).toMatch(/^wtp-[a-f0-9]{32}$/);
    expect(packet.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validateWorkflowTaskPacket(packet, plan)).toBe(true);
    expect(formatWorkflowTaskPacket(packet)).toContain("packet-codec: Canonical task packets");
  });

  test("rejects missing, multiple, nonterminal, multiline, oversized, and noncanonical markers", () => {
    const marker = canonicalWorkflowTaskPacketMarker(declaration);
    const oversized = { ...declaration, scope: ["x".repeat(301)] };
    for (const candidate of [
      "# Plan\n\nNo marker.",
      `${planWith()}\n${marker}`,
      `${marker}\n\n# trailing plan text`,
      marker.replace(">\{", ">\n{"),
      `<workflow-task-packet>${JSON.stringify(oversized)}</workflow-task-packet>`,
      marker.replace(":1,", ": 1,"),
      `<workflow-task-packet>${JSON.stringify({ schemaVersion: 1, nonGoals: declaration.nonGoals, scope: declaration.scope, acceptanceCriteria: declaration.acceptanceCriteria })}</workflow-task-packet>`,
      marker.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      marker.replace('"scope":', '"unknown":[],"scope":'),
    ]) {
      expect(() => parseWorkflowTaskPacket(candidate)).toThrow();
    }
  });

  test("rejects every declaration bound and uniqueness violation", () => {
    const badDeclarations: unknown[] = [
      { ...declaration, schemaVersion: 2 },
      { ...declaration, scope: [] },
      { ...declaration, scope: Array.from({ length: 17 }, (_, index) => `scope ${index}`) },
      { ...declaration, scope: [" duplicate", "duplicate"] },
      { ...declaration, nonGoals: ["same", "same"] },
      { ...declaration, acceptanceCriteria: [] },
      { ...declaration, acceptanceCriteria: Array.from({ length: 17 }, (_, index) => ({ id: `criterion-${index}`, description: "ok", requiredEvidenceKinds: ["automated-test"] })) },
      { ...declaration, acceptanceCriteria: [{ id: "Bad_Id", description: "ok", requiredEvidenceKinds: ["automated-test"] }] },
      { ...declaration, acceptanceCriteria: [{ id: `a${"b".repeat(64)}`, description: "ok", requiredEvidenceKinds: ["automated-test"] }] },
      { ...declaration, acceptanceCriteria: [{ id: "valid", description: "line one\nline two", requiredEvidenceKinds: ["automated-test"] }] },
      { ...declaration, acceptanceCriteria: [{ id: "valid", description: "x".repeat(501), requiredEvidenceKinds: ["automated-test"] }] },
      { ...declaration, acceptanceCriteria: [{ id: "valid", description: "ok", requiredEvidenceKinds: [] }] },
      { ...declaration, acceptanceCriteria: [{ id: "valid", description: "ok", requiredEvidenceKinds: ["automated-test", "automated-test"] }] },
      { ...declaration, acceptanceCriteria: [{ id: "valid", description: "ok", requiredEvidenceKinds: ["command-output"] }] },
      { ...declaration, acceptanceCriteria: [declaration.acceptanceCriteria[0], { ...declaration.acceptanceCriteria[0] }] },
    ];
    for (const value of badDeclarations) {
      const marker = `<workflow-task-packet>${JSON.stringify(value)}</workflow-task-packet>`;
      expect(() => parseWorkflowTaskPacket(`# Plan\n\n${marker}`)).toThrow();
    }
  });

  test("rejects unsafe controls, line separators, and unpaired surrogates in packet text", () => {
    for (const unsafe of ["control\u0000text", "delete\u007ftext", "line\u2028separator", "paragraph\u2029separator", "unpaired\ud800surrogate", "terminal-surrogate\ud800"]) {
      const value = { ...declaration, scope: [unsafe] };
      expect(() => parseWorkflowTaskPacket(`# Plan\n\n<workflow-task-packet>${JSON.stringify(value)}</workflow-task-packet>`)).toThrow();
    }
  });

  test("rejects packets rebound to changed plan, declaration, digest, or id", () => {
    const plan = planWith();
    const packet = bindWorkflowTaskPacket(plan);
    expect(validateWorkflowTaskPacket(packet, `${plan}\nchanged`)).toBe(false);
    expect(validateWorkflowTaskPacket({ ...packet, scope: ["changed"] }, plan)).toBe(false);
    expect(validateWorkflowTaskPacket({ ...packet, planDigest: `sha256:${"0".repeat(64)}` }, plan)).toBe(false);
    expect(validateWorkflowTaskPacket({ ...packet, packetId: `wtp-${"0".repeat(32)}` }, plan)).toBe(false);
  });

  test("visual packets need runtime observation and artifact inspection", () => {
    expect(visualPacketHasRequiredEvidence(bindWorkflowTaskPacket(planWith()))).toBe(false);
    const visual = canonicalWorkflowTaskPacketMarker({
      schemaVersion: 1,
      scope: ["Render the surface"],
      nonGoals: ["No unrelated edits"],
      acceptanceCriteria: [{
        id: "surface",
        description: "The page is exercised and captured",
        requiredEvidenceKinds: ["runtime-observation", "artifact-inspection"],
      }],
    });
    expect(visualPacketHasRequiredEvidence(bindWorkflowTaskPacket(`# Plan\n\n${visual}`))).toBe(true);
  });
});

describe("workflow packet prompt disclosure", () => {
  test("sends only packet binding to execution roles and full criteria to the verifier", () => {
    const plan = planWith();
    const packet = bindWorkflowTaskPacket(plan);
    const executionPrompts = [
      buildExecutionBriefTask("task", plan, packet),
      buildImplementationTask("task", plan, "brief", packet),
      buildCodeReviewTask("quality-reviewer", "task", plan, "implementation", packet),
      buildCodeReviewTask("technical-reviewer", "task", plan, "implementation", packet),
      buildFixTask("task", plan, "implementation", "reviews", "- criterion failed.", packet),
    ];
    for (const prompt of executionPrompts) {
      expect(prompt).toContain(packet.packetId);
      expect(prompt).toContain(packet.planDigest);
      expect(prompt.match(/packet-codec/g)).toHaveLength(1);
      expect(prompt).not.toContain("Acceptance criteria:\n-");
    }

    const verifierPrompt = buildPacketVerificationTask("task", plan, "implementation", packet);
    expect(verifierPrompt.match(/packet-codec/g)).toHaveLength(2);
    expect(verifierPrompt).toContain("Acceptance criteria:\n- packet-codec:");
  });
});

describe("workflow packet verification codec", () => {
  test("fabricated text, missing checks, wrong criteria, failed commands and stale snapshots cannot pass", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const output = verificationOutput();
    expect(evaluateWorkflowVerification(output, packet)).toMatchObject({ result: "protocol-failure", protocolFailure: "missing-host-evidence" });
    const observed = observedChecks(packet.acceptanceCriteria);
    for (const candidate of [
      { ...observed, receipts: [] },
      { ...observed, snapshot: "changed" },
      { ...observed, receipts: observed.receipts.map((item) => ({ ...item, exitCode: 1 })) },
      { ...observed, receipts: observed.receipts.map((item) => ({ ...item, criterionIds: ["other"] })) },
    ]) expect(packetVerificationPasses(evaluateWorkflowVerification(output, packet, candidate))).toBe(false);
  });
  test("accepts only an exactly bound, complete passing canonical marker", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const evaluation = evaluateWorkflowVerification(` \n${verificationOutput()}\n`, packet, observedChecks(packet.acceptanceCriteria));
    expect(packetVerificationPasses(evaluation)).toBe(true);
    expect(evaluation).toMatchObject({ result: "passed", packetId: packet.packetId, planDigest: packet.planDigest });
  });

  test("rejects legacy markers, envelope text, multiline, oversize, reordered, duplicate, unknown, and wrong binding payloads", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const canonical = verificationPayload(packet);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const candidates = [
      "<verified/>",
      `${verificationOutput(canonical)}\nraw command output`,
      `<workflow-verification>\n${canonical}\n</workflow-verification>`,
      `<workflow-verification>${"x".repeat(48 * 1024 + 1)}</workflow-verification>`,
      verificationOutput(canonical.replace('"schemaVersion":1,"packetId"', '"packetId":"wrong","schemaVersion":1,"discarded"')),
      verificationOutput(canonical.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
      verificationOutput(canonical.replace('"criteria":', '"unknown":true,"criteria":')),
      verificationOutput(JSON.stringify({ ...parsed, packetId: `wtp-${"0".repeat(32)}` })),
      verificationOutput(JSON.stringify({ ...parsed, planDigest: `sha256:${"0".repeat(64)}` })),
    ];
    for (const candidate of candidates) {
      const evaluation = evaluateWorkflowVerification(candidate, packet);
      expect(packetVerificationPasses(evaluation)).toBe(false);
      expect(evaluation.result).toBe("protocol-failure");
      expect(JSON.stringify(evaluation)).not.toContain(candidate);
    }
  });

  test("fails unknown, missing, duplicate, wrong-kind, failed, and skipped criteria without preserving raw output", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const base = JSON.parse(verificationPayload(packet)) as { criteria: Array<Record<string, unknown>> } & Record<string, unknown>;
    const first = base.criteria[0];
    const evidence = first.evidence as Array<Record<string, string>>;
    const cases = [
      { ...base, criteria: [...base.criteria, { criterionId: "unknown", status: "passed", evidence: [] }] },
      { ...base, criteria: base.criteria.slice(0, 1) },
      { ...base, criteria: [base.criteria[0], base.criteria[0]] },
      { ...base, criteria: [{ ...first, evidence: [evidence[0]] }, base.criteria[1]] },
      { ...base, criteria: [{ ...first, evidence: [...evidence, { kind: "build", summary: "Unexpected kind." }] }, base.criteria[1]] },
      { ...base, criteria: [{ ...first, status: "failed" }, base.criteria[1]] },
      { ...base, criteria: [base.criteria[0], { ...base.criteria[1], status: "skipped" }] },
    ];
    for (const value of cases) {
      const output = verificationOutput(JSON.stringify(value));
      const evaluation = evaluateWorkflowVerification(output, packet);
      expect(packetVerificationPasses(evaluation)).toBe(false);
    }
  });

  test("keeps a maximum-size valid envelope below both protocol and agent output caps", () => {
    const maximumDeclaration: WorkflowTaskPacketDeclaration = {
      schemaVersion: 1,
      scope: Array.from({ length: 16 }, (_, index) => `${index}-${"s".repeat(297)}`),
      nonGoals: Array.from({ length: 16 }, (_, index) => `${index}-${"n".repeat(297)}`),
      acceptanceCriteria: Array.from({ length: 16 }, (_, index) => ({
        id: `criterion-${index}`,
        description: `${index}-${"d".repeat(497)}`,
        requiredEvidenceKinds: ["automated-test", "static-analysis", "build", "runtime-observation", "artifact-inspection"],
      })),
    };
    const plan = planWith(canonicalWorkflowTaskPacketMarker(maximumDeclaration));
    const packet = bindWorkflowTaskPacket(plan);
    const payload = JSON.stringify({
      schemaVersion: 1,
      packetId: packet.packetId,
      planDigest: packet.planDigest,
      criteria: packet.acceptanceCriteria.map((criterion, criterionIndex) => ({
        criterionId: criterion.id,
        status: "passed",
        evidence: criterion.requiredEvidenceKinds.map((kind, evidenceIndex) => ({
          kind,
          summary: `${criterionIndex}-${evidenceIndex}-${"e".repeat(295)}`,
        })),
      })),
    });
    const output = verificationOutput(payload);
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThan(48 * 1024);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(50 * 1024);
    expect(packetVerificationPasses(evaluateWorkflowVerification(output, packet, observedChecks(packet.acceptanceCriteria)))).toBe(true);
  });

  test("rejects oversized or unsafe evidence and non-required failed/skipped evidence", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const base = JSON.parse(verificationPayload(packet)) as { criteria: Array<Record<string, unknown>> } & Record<string, unknown>;
    const first = base.criteria[0];
    for (const evidence of [
      [{ kind: "automated-test", summary: "x".repeat(301) }],
      [{ kind: "automated-test", summary: "unsafe\u0000summary" }],
      [{ kind: "automated-test", summary: "unsafe\u2028summary" }],
      [{ kind: "automated-test", summary: "unsafe\u2029summary" }],
      [{ kind: "automated-test", summary: "unsafe\ud800summary" }],
      [{ kind: "automated-test", summary: "unsafe-terminal\ud800" }],
      [{ kind: "build", summary: "A non-required build failed." }],
    ]) {
      for (const status of ["failed", "skipped"]) {
        const value = { ...base, criteria: [{ ...first, status, evidence }, base.criteria[1]] };
        expect(evaluateWorkflowVerification(verificationOutput(JSON.stringify(value)), packet).result).toBe("protocol-failure");
      }
    }
  });

  test("formats only concise structured failures for fix prompts", () => {
    const packet = bindWorkflowTaskPacket(planWith());
    const value = JSON.parse(verificationPayload(packet)) as { criteria: Array<Record<string, unknown>> } & Record<string, unknown>;
    value.criteria[0] = { ...value.criteria[0], status: "failed", evidence: [{ kind: "automated-test", summary: "One focused test failed." }] };
    const output = verificationOutput(JSON.stringify(value));
    const evaluation = evaluateWorkflowVerification(output, packet);
    expect(evaluation.result).toBe("failed");
    expect(formatWorkflowVerificationFailures(evaluation)).toBe("- packet-codec: failed.");
    expect(JSON.stringify(evaluation)).not.toContain("<workflow-verification>");
  });
});
