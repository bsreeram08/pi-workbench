import { createHash } from "node:crypto";
import { checkPassed, type VerificationEvidence } from "./verification.ts";

export const WORKFLOW_EVIDENCE_KINDS = [
  "automated-test",
  "static-analysis",
  "build",
  "runtime-observation",
  "artifact-inspection",
] as const;

export type WorkflowEvidenceKind = typeof WORKFLOW_EVIDENCE_KINDS[number];

export interface WorkflowAcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiredEvidenceKinds: WorkflowEvidenceKind[];
}

export interface WorkflowTaskPacketDeclaration {
  readonly schemaVersion: 1;
  readonly scope: string[];
  readonly nonGoals: string[];
  readonly acceptanceCriteria: WorkflowAcceptanceCriterion[];
}

export interface WorkflowTaskPacket extends WorkflowTaskPacketDeclaration {
  readonly packetId: string;
  readonly planDigest: string;
}

export type WorkflowVerificationStatus = "passed" | "failed" | "skipped";

export interface WorkflowVerificationEvidence {
  readonly kind: WorkflowEvidenceKind;
  readonly summary: string;
}

export interface WorkflowCriterionVerification {
  readonly criterionId: string;
  readonly status: WorkflowVerificationStatus;
  readonly evidence: WorkflowVerificationEvidence[];
}

export type WorkflowVerificationProtocolFailure =
  | "legacy-marker"
  | "malformed-envelope"
  | "invalid-payload"
  | "binding-mismatch"
  | "missing-host-evidence";

interface WorkflowPacketVerificationBase {
  readonly schemaVersion: 1;
  readonly packetId: string;
  readonly planDigest: string;
  readonly verifierOutputDigest: string;
}

export interface WorkflowPacketVerificationResult extends WorkflowPacketVerificationBase {
  readonly result: "passed" | "failed";
  readonly criteria: WorkflowCriterionVerification[];
}

export interface WorkflowPacketVerificationProtocolFailureState extends WorkflowPacketVerificationBase {
  readonly result: "protocol-failure";
  readonly protocolFailure: WorkflowVerificationProtocolFailure;
}

export type WorkflowPacketVerification = WorkflowPacketVerificationResult | WorkflowPacketVerificationProtocolFailureState;

const DECLARATION_KEYS = ["schemaVersion", "scope", "nonGoals", "acceptanceCriteria"] as const;
const CRITERION_KEYS = ["id", "description", "requiredEvidenceKinds"] as const;
const PACKET_KEYS = ["schemaVersion", "packetId", "planDigest", "scope", "nonGoals", "acceptanceCriteria"] as const;
const VERIFICATION_KEYS = ["schemaVersion", "packetId", "planDigest", "criteria"] as const;
const VERIFICATION_CRITERION_KEYS = ["criterionId", "status", "evidence"] as const;
const EVIDENCE_KEYS = ["kind", "summary"] as const;
const VERIFICATION_RESULT_KEYS = ["schemaVersion", "packetId", "planDigest", "verifierOutputDigest", "result", "criteria"] as const;
const VERIFICATION_FAILURE_KEYS = ["schemaVersion", "packetId", "planDigest", "verifierOutputDigest", "result", "protocolFailure"] as const;
const EVIDENCE_KINDS = new Set<WorkflowEvidenceKind>(WORKFLOW_EVIDENCE_KINDS);
const CRITERION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TASK_PACKET_OPEN = "<workflow-task-packet>";
const TASK_PACKET_CLOSE = "</workflow-task-packet>";
const VERIFICATION_OPEN = "<workflow-verification>";
const VERIFICATION_CLOSE = "</workflow-verification>";
const MAX_DECLARATION_BYTES = 32 * 1024;
const MAX_VERIFICATION_BYTES = 48 * 1024;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isBoundedOneLine(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !UNSAFE_TEXT.test(value)
    && !hasUnpairedSurrogate(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validStringList(value: unknown, minimum: number, maximum: number, maximumBytes: number): value is string[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((item) => isBoundedOneLine(item, maximumBytes))
    && isUnique(value);
}

function validEvidenceKind(value: unknown): value is WorkflowEvidenceKind {
  return typeof value === "string" && EVIDENCE_KINDS.has(value as WorkflowEvidenceKind);
}

function validAcceptanceCriterion(value: unknown): value is WorkflowAcceptanceCriterion {
  if (!isRecord(value) || !hasExactKeys(value, CRITERION_KEYS)) return false;
  if (!isBoundedOneLine(value.id, 64) || !CRITERION_ID.test(value.id)) return false;
  if (!isBoundedOneLine(value.description, 500)) return false;
  return Array.isArray(value.requiredEvidenceKinds)
    && value.requiredEvidenceKinds.length >= 1
    && value.requiredEvidenceKinds.length <= 5
    && value.requiredEvidenceKinds.every(validEvidenceKind)
    && isUnique(value.requiredEvidenceKinds);
}

function validDeclaration(value: unknown): value is WorkflowTaskPacketDeclaration {
  if (!isRecord(value) || !hasExactKeys(value, DECLARATION_KEYS) || value.schemaVersion !== 1) return false;
  if (!validStringList(value.scope, 1, 16, 300) || !validStringList(value.nonGoals, 1, 16, 300)) return false;
  if (!Array.isArray(value.acceptanceCriteria) || value.acceptanceCriteria.length < 1 || value.acceptanceCriteria.length > 16) return false;
  if (!value.acceptanceCriteria.every(validAcceptanceCriterion)) return false;
  return isUnique(value.acceptanceCriteria.map((criterion) => criterion.id));
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = value.indexOf(needle, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function parseCanonicalJson(payload: string): unknown {
  if (/[\r\n]/.test(payload)) throw new Error("Workflow marker JSON must be one line.");
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error("Workflow marker JSON is malformed.");
  }
}

export function canonicalWorkflowTaskPacketMarker(declaration: WorkflowTaskPacketDeclaration): string {
  if (!validDeclaration(declaration)) throw new Error("Workflow task packet declaration is invalid.");
  const payload = JSON.stringify(declaration);
  if (Buffer.byteLength(payload, "utf8") > MAX_DECLARATION_BYTES) throw new Error("Workflow task packet declaration is oversized.");
  return `${TASK_PACKET_OPEN}${payload}${TASK_PACKET_CLOSE}`;
}

export function parseWorkflowTaskPacket(plan: string): WorkflowTaskPacketDeclaration {
  const trimmed = plan.trim();
  if (occurrences(trimmed, TASK_PACKET_OPEN) !== 1 || occurrences(trimmed, TASK_PACKET_CLOSE) !== 1) {
    throw new Error("Plan must contain exactly one workflow task packet marker.");
  }
  const markerStart = trimmed.lastIndexOf(TASK_PACKET_OPEN);
  if (markerStart < 0 || !trimmed.endsWith(TASK_PACKET_CLOSE)) throw new Error("Workflow task packet marker must be terminal.");
  const payloadStart = markerStart + TASK_PACKET_OPEN.length;
  const payload = trimmed.slice(payloadStart, trimmed.length - TASK_PACKET_CLOSE.length);
  if (Buffer.byteLength(payload, "utf8") > MAX_DECLARATION_BYTES) throw new Error("Workflow task packet declaration is oversized.");
  const value = parseCanonicalJson(payload);
  if (!validDeclaration(value) || JSON.stringify(value) !== payload) {
    throw new Error("Workflow task packet declaration is noncanonical or invalid.");
  }
  return value;
}

export function visualPacketHasRequiredEvidence(packet: Pick<WorkflowTaskPacket, "acceptanceCriteria">): boolean {
  const kinds = new Set(packet.acceptanceCriteria.flatMap((criterion) => criterion.requiredEvidenceKinds));
  return kinds.has("runtime-observation") && kinds.has("artifact-inspection");
}

export function bindWorkflowTaskPacket(plan: string): WorkflowTaskPacket {
  const trimmed = plan.trim();
  const declaration = parseWorkflowTaskPacket(trimmed);
  const planHash = digest(trimmed);
  return {
    schemaVersion: 1,
    packetId: `wtp-${planHash.slice(0, 32)}`,
    planDigest: `sha256:${planHash}`,
    scope: declaration.scope,
    nonGoals: declaration.nonGoals,
    acceptanceCriteria: declaration.acceptanceCriteria,
  };
}

export function validateWorkflowTaskPacket(value: unknown, plan: string): value is WorkflowTaskPacket {
  if (!isRecord(value) || !hasExactKeys(value, PACKET_KEYS)) return false;
  let expected: WorkflowTaskPacket;
  try {
    expected = bindWorkflowTaskPacket(plan);
  } catch {
    return false;
  }
  return JSON.stringify(value) === JSON.stringify(expected);
}

function validVerificationEvidence(value: unknown): value is WorkflowVerificationEvidence {
  return isRecord(value)
    && hasExactKeys(value, EVIDENCE_KEYS)
    && validEvidenceKind(value.kind)
    && isBoundedOneLine(value.summary, 300);
}

function validVerificationCriterion(
  value: unknown,
  expected: WorkflowAcceptanceCriterion,
): value is WorkflowCriterionVerification {
  if (!isRecord(value) || !hasExactKeys(value, VERIFICATION_CRITERION_KEYS)) return false;
  if (value.criterionId !== expected.id || !["passed", "failed", "skipped"].includes(String(value.status))) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every(validVerificationEvidence)) return false;
  const kinds = value.evidence.map((item) => item.kind);
  if (!isUnique(kinds)) return false;
  if (!kinds.every((kind) => expected.requiredEvidenceKinds.includes(kind))) return false;
  if (value.status === "passed") {
    return kinds.length === expected.requiredEvidenceKinds.length
      && expected.requiredEvidenceKinds.every((kind) => kinds.includes(kind));
  }
  return true;
}

function protocolFailure(
  packet: WorkflowTaskPacket,
  verifierOutputDigest: string,
  failure: WorkflowVerificationProtocolFailure,
): WorkflowPacketVerificationProtocolFailureState {
  return {
    schemaVersion: 1,
    packetId: packet.packetId,
    planDigest: packet.planDigest,
    verifierOutputDigest,
    result: "protocol-failure",
    protocolFailure: failure,
  };
}

export function evaluateWorkflowVerification(output: string, packet: WorkflowTaskPacket, observed?: VerificationEvidence): WorkflowPacketVerification {
  const verifierOutputDigest = `sha256:${digest(output)}`;
  if (/<(?:verified|failed)\s*\/>/i.test(output)) return protocolFailure(packet, verifierOutputDigest, "legacy-marker");
  const trimmed = output.trim();
  if (occurrences(trimmed, VERIFICATION_OPEN) !== 1
    || occurrences(trimmed, VERIFICATION_CLOSE) !== 1
    || !trimmed.startsWith(VERIFICATION_OPEN)
    || !trimmed.endsWith(VERIFICATION_CLOSE)) {
    return protocolFailure(packet, verifierOutputDigest, "malformed-envelope");
  }
  const payload = trimmed.slice(VERIFICATION_OPEN.length, -VERIFICATION_CLOSE.length);
  if (Buffer.byteLength(payload, "utf8") > MAX_VERIFICATION_BYTES || /[\r\n]/.test(payload)) {
    return protocolFailure(packet, verifierOutputDigest, "invalid-payload");
  }
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return protocolFailure(packet, verifierOutputDigest, "invalid-payload");
  }
  if (!isRecord(value) || !hasExactKeys(value, VERIFICATION_KEYS) || value.schemaVersion !== 1 || JSON.stringify(value) !== payload) {
    return protocolFailure(packet, verifierOutputDigest, "invalid-payload");
  }
  if (value.packetId !== packet.packetId || value.planDigest !== packet.planDigest) {
    return protocolFailure(packet, verifierOutputDigest, "binding-mismatch");
  }
  if (!Array.isArray(value.criteria) || value.criteria.length !== packet.acceptanceCriteria.length) {
    return protocolFailure(packet, verifierOutputDigest, "invalid-payload");
  }
  for (let index = 0; index < packet.acceptanceCriteria.length; index++) {
    if (!validVerificationCriterion(value.criteria[index], packet.acceptanceCriteria[index])) {
      return protocolFailure(packet, verifierOutputDigest, "invalid-payload");
    }
  }
  const criteria = value.criteria as WorkflowCriterionVerification[];
  for (const criterion of criteria.every((item) => item.status === "passed") ? criteria : []) {
    if (!observed || criterion.evidence.some(({ kind }) => {
      const checks = observed.receipts.filter((receipt) => receipt.kind === kind && receipt.criterionIds.includes(criterion.criterionId));
      return checks.length === 0 || !checks.every((receipt) => checkPassed(receipt, observed.snapshot));
    })) return protocolFailure(packet, verifierOutputDigest, "missing-host-evidence");
  }
  return {
    schemaVersion: 1,
    packetId: packet.packetId,
    planDigest: packet.planDigest,
    verifierOutputDigest,
    result: criteria.every((criterion) => criterion.status === "passed") ? "passed" : "failed",
    criteria,
  };
}

export function validateWorkflowPacketVerification(
  value: unknown,
  packet: WorkflowTaskPacket,
): value is WorkflowPacketVerification {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || value.packetId !== packet.packetId || value.planDigest !== packet.planDigest) return false;
  if (typeof value.verifierOutputDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.verifierOutputDigest)) return false;
  if (value.result === "protocol-failure") {
    return hasExactKeys(value, VERIFICATION_FAILURE_KEYS)
      && ["legacy-marker", "malformed-envelope", "invalid-payload", "binding-mismatch", "missing-host-evidence"].includes(String(value.protocolFailure));
  }
  if (!hasExactKeys(value, VERIFICATION_RESULT_KEYS) || (value.result !== "passed" && value.result !== "failed")) return false;
  if (!Array.isArray(value.criteria) || value.criteria.length !== packet.acceptanceCriteria.length) return false;
  for (let index = 0; index < packet.acceptanceCriteria.length; index++) {
    if (!validVerificationCriterion(value.criteria[index], packet.acceptanceCriteria[index])) return false;
  }
  const allPassed = value.criteria.every((criterion) => isRecord(criterion) && criterion.status === "passed");
  return (value.result === "passed") === allPassed;
}

export function packetVerificationPasses(verification: WorkflowPacketVerification): boolean {
  return verification.result === "passed"
    && verification.criteria.length > 0
    && verification.criteria.every((criterion) => criterion.status === "passed");
}

export function formatWorkflowTaskPacket(packet: WorkflowTaskPacket): string {
  return [
    `Packet: ${packet.packetId}`,
    `Plan digest: ${packet.planDigest}`,
    "Scope:",
    ...packet.scope.map((item) => `- ${item}`),
    "Non-goals:",
    ...packet.nonGoals.map((item) => `- ${item}`),
    "Acceptance criteria:",
    ...packet.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.description} [${criterion.requiredEvidenceKinds.join(", ")}]`),
  ].join("\n");
}

export function formatWorkflowVerificationFailures(verification: WorkflowPacketVerification): string {
  if (verification.result === "protocol-failure") return `- Verification protocol failure: ${verification.protocolFailure}.`;
  const failures = verification.criteria.filter((criterion) => criterion.status !== "passed");
  if (failures.length === 0) return "- No structured verification failures.";
  return failures.map((criterion) => `- ${criterion.criterionId}: ${criterion.status}.`).join("\n");
}
