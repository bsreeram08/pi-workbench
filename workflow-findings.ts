import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const WORKFLOW_FINDINGS_OPEN = "<workflow-findings>";
export const WORKFLOW_FINDINGS_CLOSE = "</workflow-findings>";

export type WorkflowFindingSeverity = "blocker" | "warning" | "note";
export type WorkflowCodeVerdict = "PASS" | "CHANGES_REQUIRED" | "BLOCKED";

export interface WorkflowFinding {
  readonly id: string;
  readonly severity: WorkflowFindingSeverity;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly evidenceDigest: string;
  readonly summary: string;
}

export interface WorkflowFindings {
  readonly schemaVersion: 1;
  readonly findings: readonly WorkflowFinding[];
}

export type CodeReviewEnvelope =
  | { readonly ok: true; readonly findings: WorkflowFindings; readonly verdict: WorkflowCodeVerdict }
  | { readonly ok: false };

const FINDINGS_KEYS = ["schemaVersion", "findings"] as const;
const FINDING_KEYS = ["id", "severity", "path", "startLine", "endLine", "evidenceDigest", "summary"] as const;
const SEVERITIES = new Set<WorkflowFindingSeverity>(["blocker", "warning", "note"]);
const FINDING_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EVIDENCE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE_VERDICT = /<code-verdict>\s*(PASS|CHANGES_REQUIRED|BLOCKED)\s*<\/code-verdict>/g;
const MAX_FINDINGS = 32;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
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

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validProjectPath(value: unknown): value is string {
  if (!isBoundedOneLine(value, 500)) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function validFinding(value: unknown): value is WorkflowFinding {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) return false;
  if (!isBoundedOneLine(value.id, 64) || !FINDING_ID.test(value.id)) return false;
  if (typeof value.severity !== "string" || !SEVERITIES.has(value.severity as WorkflowFindingSeverity)) return false;
  if (!validProjectPath(value.path)) return false;
  if (typeof value.startLine !== "number" || !Number.isSafeInteger(value.startLine) || value.startLine < 1) return false;
  if (typeof value.endLine !== "number" || !Number.isSafeInteger(value.endLine) || value.endLine < value.startLine) return false;
  if (typeof value.evidenceDigest !== "string" || !EVIDENCE_DIGEST.test(value.evidenceDigest)) return false;
  return isBoundedOneLine(value.summary, 500);
}

function validFindings(value: unknown): value is WorkflowFindings {
  if (!isRecord(value) || !hasExactKeys(value, FINDINGS_KEYS) || value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS || !value.findings.every(validFinding)) return false;
  return isUnique(value.findings.map((finding) => finding.id));
}

function parseCanonicalJson(payload: string): unknown {
  if (/[\r\n]/.test(payload)) return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function markerLineProtocol(output: string, index: number): boolean {
  const lineStart = output.lastIndexOf("\n", index - 1) + 1;
  if (!/^ {0,3}$/.test(output.slice(lineStart, index))) return false;
  let fence: { character: string; length: number } | undefined;
  for (const line of output.slice(0, lineStart).split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!delimiter) continue;
    if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
    else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
  }
  return !fence;
}

function uniqueTerminalCodeVerdict(output: string): { value: WorkflowCodeVerdict; start: number } | undefined {
  const normalized = output.toLowerCase();
  if (normalized.split("<code-verdict>").length !== 2 || normalized.split("</code-verdict>").length !== 2) return undefined;
  const matches = [...output.matchAll(CODE_VERDICT)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const start = match.index ?? 0;
  if (!markerLineProtocol(output, start)) return undefined;
  const end = start + match[0].length;
  return output.slice(end).trim() ? undefined : { value: match[1] as WorkflowCodeVerdict, start };
}

function contradictsVerdict(findings: WorkflowFindings, verdict: WorkflowCodeVerdict): boolean {
  if (verdict === "PASS") return findings.findings.some((finding) => finding.severity !== "note");
  return findings.findings.length === 0;
}

export function canonicalWorkflowFindingsMarker(value: WorkflowFindings): string {
  if (!validFindings(value)) throw new Error("Workflow findings envelope is invalid.");
  const payload = JSON.stringify(value);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("Workflow findings envelope is oversized.");
  return `${WORKFLOW_FINDINGS_OPEN}${payload}${WORKFLOW_FINDINGS_CLOSE}`;
}

export function parseWorkflowFindings(output: string): WorkflowFindings | undefined {
  if (occurrences(output, WORKFLOW_FINDINGS_OPEN) !== 1 || occurrences(output, WORKFLOW_FINDINGS_CLOSE) !== 1) return undefined;
  const markerStart = output.indexOf(WORKFLOW_FINDINGS_OPEN);
  const markerEnd = output.indexOf(WORKFLOW_FINDINGS_CLOSE);
  if (markerStart < 0 || markerEnd < markerStart + WORKFLOW_FINDINGS_OPEN.length) return undefined;
  if (!markerLineProtocol(output, markerStart)) return undefined;
  const payload = output.slice(markerStart + WORKFLOW_FINDINGS_OPEN.length, markerEnd);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) return undefined;
  const value = parseCanonicalJson(payload);
  if (!validFindings(value) || JSON.stringify(value) !== payload) return undefined;
  return value;
}

export function evaluateCodeReviewEnvelope(output: string): CodeReviewEnvelope {
  const findings = parseWorkflowFindings(output);
  const verdict = uniqueTerminalCodeVerdict(output);
  if (!findings || !verdict) return { ok: false };
  const closeEnd = output.indexOf(WORKFLOW_FINDINGS_CLOSE) + WORKFLOW_FINDINGS_CLOSE.length;
  if (output.slice(closeEnd, verdict.start) !== "\n") return { ok: false };
  if (contradictsVerdict(findings, verdict.value)) return { ok: false };
  return { ok: true, findings, verdict: verdict.value };
}

export function codeReviewEnvelopeValid(output: string): boolean {
  return evaluateCodeReviewEnvelope(output).ok;
}

export async function groundWorkflowFindings(
  root: string,
  findings: WorkflowFindings,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!validFindings(findings)) return { ok: false, reason: "invalid-payload" };
  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(root);
  } catch {
    return { ok: false, reason: "missing-root" };
  }
  for (const finding of findings.findings) {
    if (path.isAbsolute(finding.path) || path.win32.isAbsolute(finding.path)) return { ok: false, reason: "path-escape" };
    const file = path.resolve(resolvedRoot, finding.path);
    if (!within(resolvedRoot, file)) return { ok: false, reason: "path-escape" };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) return { ok: false, reason: "not-a-file" };
      if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: "oversized-file" };
      if (!within(resolvedRoot, await fs.realpath(file))) return { ok: false, reason: "path-escape" };
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== stat.size) return { ok: false, reason: "truncated-file" };
      const lines = buffer.toString("utf8").split("\n");
      if (finding.endLine > lines.length) return { ok: false, reason: "line-range" };
      const slice = lines.slice(finding.startLine - 1, finding.endLine).join("\n");
      if (`sha256:${digest(slice)}` !== finding.evidenceDigest) return { ok: false, reason: "digest-mismatch" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, reason: "missing-file" };
      if (code === "ELOOP" || code === "EMLINK") return { ok: false, reason: "not-a-file" };
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return { ok: true };
}
