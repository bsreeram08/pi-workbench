import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  packetVerificationPasses,
  validateWorkflowPacketVerification,
  validateWorkflowTaskPacket,
  type WorkflowPacketVerification,
  type WorkflowTaskPacket,
} from "./workflow-task-packet.ts";

export type WorkflowPlanStatus = "draft" | "approved" | "executing" | "verified" | "blocked" | "cancelled" | "interrupted";
export type WorkflowVerificationMode = "packet";

export interface WorkflowReviewAttempt {
  status: "running" | "passed" | "rejected" | "interrupted" | "cancelled";
  planDigest: string;
  snapshot?: string;
  policyDigest?: string;
  inputDigest?: string;
  recoveryAttempts: number;
  model?: string;
  error?: string;
}

export interface WorkflowDesignBrief {
  direction: string;
  hierarchy: string;
  interactions: string;
  responsiveAccessibility: string;
  constraints: string;
}

export interface WorkflowExecutionState {
  startedAt: string;
  completedAt?: string;
  attempts: number;
  verificationPassed: boolean;
  summary?: string;
  packetVerification?: WorkflowPacketVerification;
  review?: WorkflowReviewAttempt;
}

export interface WorkflowPlanState {
  version: 1;
  id: string;
  task: string;
  status: WorkflowPlanStatus;
  plan: string;
  interviewNotes: string;
  createdAt: string;
  updatedAt: string;
  reviewRounds: number;
  planPath: string;
  verificationMode?: WorkflowVerificationMode;
  packet?: WorkflowTaskPacket;
  execution?: WorkflowExecutionState;
  planningReview?: WorkflowReviewAttempt;
  designBrief?: WorkflowDesignBrief;
}

export interface WorkflowPaths {
  root: string;
  current: string;
  plans: string;
  runs: string;
}

export interface WorkflowStateWriteFaults {
  beforePlanCommit?(temporaryPath: string, destinationPath: string): void | Promise<void>;
  beforeCurrentCommit?(temporaryPath: string, destinationPath: string): void | Promise<void>;
}

export type WorkflowStateCorruptionCode = "authoritative_file_unsafe" | "read_failed" | "malformed_json" | "invalid_state";

export interface WorkflowAuthoritySnapshot {
  readonly content?: string;
  readonly state?: WorkflowPlanState;
}

export class WorkflowStateSnapshotMismatchError extends Error {
  constructor() {
    super("Authoritative workflow state changed after confirmation; rerun the command and reconfirm.");
    this.name = "WorkflowStateSnapshotMismatchError";
  }
}

export class WorkflowStateCorruptionError extends Error {
  readonly code: WorkflowStateCorruptionCode;

  constructor(code: WorkflowStateCorruptionCode, cause?: unknown) {
    super(`Workflow state is corrupt or unreadable (${code}).`, cause === undefined ? undefined : { cause });
    this.name = "WorkflowStateCorruptionError";
    this.code = code;
  }
}

const STATUSES = new Set<WorkflowPlanStatus>(["draft", "approved", "executing", "verified", "blocked", "cancelled", "interrupted"]);
const stateWrites = new Map<string, Promise<void>>();

export function getWorkflowPaths(councilStateDir: string): WorkflowPaths {
  const root = path.join(councilStateDir, "workflow");
  return {
    root,
    current: path.join(root, "current.json"),
    plans: path.join(root, "plans"),
    runs: path.join(root, "runs"),
  };
}

export function createWorkflowPlanId(task: string, now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "plan";
  return `${timestamp}-${slug}`;
}

function planDocument(state: WorkflowPlanState): string {
  return `> Status: ${state.status}\n> Plan ID: ${state.id}\n> Updated: ${state.updatedAt}\n\n${state.plan.trim()}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFiniteInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Number.isFinite(value) && value >= minimum;
}

function expectedPlanPath(paths: WorkflowPaths, id: string): string {
  return path.join(path.resolve(paths.plans), `${id}.md`);
}

function validExecution(value: unknown, packet: WorkflowTaskPacket | undefined): value is WorkflowExecutionState {
  if (!isRecord(value) || !hasOnlyKeys(value, ["startedAt", "completedAt", "attempts", "verificationPassed", "summary", "packetVerification", "review"])) return false;
  if (value.review !== undefined && !validReviewAttempt(value.review)) return false;
  if (!isIso(value.startedAt)
    || (value.completedAt !== undefined && (!isIso(value.completedAt) || Date.parse(value.completedAt) < Date.parse(value.startedAt)))
    || !isFiniteInteger(value.attempts)
    || typeof value.verificationPassed !== "boolean"
    || (value.summary !== undefined && typeof value.summary !== "string")) return false;
  if (value.packetVerification === undefined) return true;
  return packet !== undefined && validateWorkflowPacketVerification(value.packetVerification, packet);
}

function validReviewAttempt(value: unknown): value is WorkflowReviewAttempt {
  return isRecord(value) && hasOnlyKeys(value, ["status", "planDigest", "snapshot", "policyDigest", "inputDigest", "recoveryAttempts", "model", "error"])
    && ["running", "passed", "rejected", "interrupted", "cancelled"].includes(value.status as string)
    && typeof value.planDigest === "string" && /^(sha256:)?[a-f0-9]{64}$/.test(value.planDigest)
    && (value.snapshot === undefined || typeof value.snapshot === "string" && /^[a-f0-9]{64}$/.test(value.snapshot))
    && (value.policyDigest === undefined || typeof value.policyDigest === "string" && /^[a-f0-9]{64}$/.test(value.policyDigest))
    && (value.inputDigest === undefined || typeof value.inputDigest === "string" && /^[a-f0-9]{64}$/.test(value.inputDigest))
    && isFiniteInteger(value.recoveryAttempts) && value.recoveryAttempts <= 1
    && (value.model === undefined || typeof value.model === "string" && value.model.length <= 512)
    && (value.error === undefined || typeof value.error === "string" && value.error.length <= 4000);
}

function validateState(value: unknown, paths: WorkflowPaths): value is WorkflowPlanState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "id", "task", "status", "plan", "interviewNotes", "createdAt", "updatedAt", "reviewRounds", "planPath", "verificationMode", "packet", "execution", "planningReview", "designBrief",
  ])) return false;
  if (value.version !== 1 || typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id) || value.id.includes("..")) return false;
  if (typeof value.task !== "string" || !value.task.trim() || typeof value.plan !== "string" || !value.plan.trim()) return false;
  if (typeof value.interviewNotes !== "string" || typeof value.status !== "string" || !STATUSES.has(value.status as WorkflowPlanStatus)) return false;
  if (!isIso(value.createdAt) || !isIso(value.updatedAt) || !isFiniteInteger(value.reviewRounds)) return false;
  if (typeof value.planPath !== "string" || path.resolve(value.planPath) !== expectedPlanPath(paths, value.id)) return false;
  if (value.verificationMode !== undefined && value.verificationMode !== "packet") return false;
  const packetMode = value.verificationMode === "packet";
  if (!packetMode && value.packet !== undefined) return false;
  if (value.packet !== undefined && !validateWorkflowTaskPacket(value.packet, value.plan)) return false;
  const packet = value.packet as WorkflowTaskPacket | undefined;
  if (value.execution !== undefined && !validExecution(value.execution, packet)) return false;
  if (value.planningReview !== undefined && !validReviewAttempt(value.planningReview)) return false;
  if (value.designBrief !== undefined) {
    const keys = ["direction", "hierarchy", "interactions", "responsiveAccessibility", "constraints"];
    if (!isRecord(value.designBrief) || !hasOnlyKeys(value.designBrief, keys)
      || !keys.every((key) => typeof (value.designBrief as Record<string, unknown>)[key] === "string"
        && ((value.designBrief as Record<string, string>)[key]!).trim().length > 0
        && ((value.designBrief as Record<string, string>)[key]!).length <= 4000)) return false;
  }

  const status = value.status as WorkflowPlanStatus;
  const execution = value.execution as WorkflowExecutionState | undefined;
  const requiresBoundPacket = status === "approved" || execution !== undefined;
  if (packetMode && requiresBoundPacket && packet === undefined) return false;
  if (!packetMode && requiresBoundPacket && value.plan.includes("<workflow-task-packet>")) return false;
  if ((status === "executing" || status === "verified") && !execution) return false;
  if ((status === "draft" || status === "approved") && execution !== undefined) return false;
  if (status === "executing" && execution?.completedAt !== undefined) return false;
  if (["verified", "blocked", "cancelled", "interrupted"].includes(status) && execution !== undefined && execution.completedAt === undefined) return false;
  if (status === "draft" && packet !== undefined) return false;
  if (status === "verified" && (!execution?.verificationPassed || !execution.completedAt)) return false;
  if (execution?.verificationPassed && status !== "verified") return false;
  if (packet === undefined && execution?.packetVerification !== undefined) return false;
  if (packet !== undefined && status === "verified" && (!execution?.packetVerification || !packetVerificationPasses(execution.packetVerification))) return false;
  if (packet !== undefined && execution?.verificationPassed && (!execution.packetVerification || !packetVerificationPasses(execution.packetVerification))) return false;
  return true;
}

function workflowDirectoryChain(paths: WorkflowPaths, includeStorage: boolean): string[] {
  const stateDir = path.dirname(paths.root);
  const configDir = path.dirname(stateDir);
  return includeStorage
    ? [configDir, stateDir, paths.root, paths.plans, paths.runs]
    : [configDir, stateDir, paths.root];
}

async function assertSafeDirectory(directory: string): Promise<"present" | "missing"> {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkflowStateCorruptionError("authoritative_file_unsafe");
    }
    return "present";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "missing";
    if (error instanceof WorkflowStateCorruptionError) throw error;
    throw new WorkflowStateCorruptionError("read_failed", error);
  }
}

async function existingWorkflowDirectoriesAreSafe(paths: WorkflowPaths): Promise<boolean> {
  for (const directory of workflowDirectoryChain(paths, false)) {
    if (await assertSafeDirectory(directory) === "missing") return false;
  }
  return true;
}

export async function ensureWorkflowState(paths: WorkflowPaths): Promise<void> {
  for (const directory of workflowDirectoryChain(paths, true)) {
    if (await assertSafeDirectory(directory) === "present") continue;
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    if (await assertSafeDirectory(directory) !== "present") {
      throw new WorkflowStateCorruptionError("authoritative_file_unsafe");
    }
  }
}

async function atomicWrite(destination: string, content: string, beforeCommit?: WorkflowStateWriteFaults["beforePlanCommit"]): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeCommit?.(temporary, destination);
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function serializeWrite(root: string, write: () => Promise<void>): Promise<void> {
  const previous = stateWrites.get(root) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => turn);
  stateWrites.set(root, queued);
  await previous.catch(() => undefined);
  try {
    await write();
  } finally {
    release();
    if (stateWrites.get(root) === queued) stateWrites.delete(root);
  }
}

export async function saveWorkflowPlan(paths: WorkflowPaths, state: WorkflowPlanState, faults: WorkflowStateWriteFaults = {}): Promise<void> {
  const planPath = expectedPlanPath(paths, state.id);
  if (state.planPath && path.resolve(state.planPath) !== planPath) throw new WorkflowStateCorruptionError("invalid_state");
  const normalized: WorkflowPlanState = { ...state, planPath };
  if (!validateState(normalized, paths)) throw new WorkflowStateCorruptionError("invalid_state");

  await serializeWrite(path.resolve(paths.root), async () => {
    await ensureWorkflowState(paths);
    await atomicWrite(planPath, planDocument(normalized), faults.beforePlanCommit);
    await atomicWrite(paths.current, `${JSON.stringify(normalized, null, 2)}\n`, faults.beforeCurrentCommit);
  });
  state.planPath = planPath;
}

async function readWorkflowAuthority(paths: WorkflowPaths): Promise<WorkflowAuthoritySnapshot> {
  if (!await existingWorkflowDirectoriesAreSafe(paths)) return {};
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(paths.current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return {};
    if (code === "ELOOP") throw new WorkflowStateCorruptionError("authoritative_file_unsafe", error);
    throw new WorkflowStateCorruptionError("read_failed", error);
  }

  let content: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WorkflowStateCorruptionError("authoritative_file_unsafe");
    content = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof WorkflowStateCorruptionError) throw error;
    throw new WorkflowStateCorruptionError("read_failed", error);
  } finally {
    await handle.close().catch(() => undefined);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new WorkflowStateCorruptionError("malformed_json", error);
  }
  if (!validateState(value, paths)) throw new WorkflowStateCorruptionError("invalid_state");
  return { content, state: value };
}

export async function captureWorkflowAuthority(paths: WorkflowPaths): Promise<WorkflowAuthoritySnapshot> {
  return readWorkflowAuthority(paths);
}

export async function assertWorkflowAuthorityUnchanged(
  paths: WorkflowPaths,
  expected: WorkflowAuthoritySnapshot,
): Promise<WorkflowPlanState | undefined> {
  const current = await readWorkflowAuthority(paths);
  if (current.content !== expected.content) throw new WorkflowStateSnapshotMismatchError();
  return current.state;
}

export async function loadCurrentWorkflowPlan(paths: WorkflowPaths): Promise<WorkflowPlanState | undefined> {
  return (await readWorkflowAuthority(paths)).state;
}

export async function writeWorkflowRunArtifact(
  paths: WorkflowPaths,
  planId: string,
  name: string,
  content: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(planId) || planId.includes("..")) throw new WorkflowStateCorruptionError("invalid_state");
  await ensureWorkflowState(paths);
  const safeName = name.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
  const runDir = path.join(paths.runs, planId);
  const runStat = await assertSafeDirectory(runDir);
  if (runStat === "missing") {
    try {
      await fs.mkdir(runDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await assertSafeDirectory(runDir) !== "present") throw new WorkflowStateCorruptionError("authoritative_file_unsafe");
  }
  const artifactPath = path.join(runDir, safeName.endsWith(".md") ? safeName : `${safeName}.md`);
  const destination = await fs.lstat(artifactPath).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (destination && (destination.isSymbolicLink() || !destination.isFile())) {
    throw new WorkflowStateCorruptionError("authoritative_file_unsafe");
  }
  await atomicWrite(artifactPath, `${content.trim()}\n`);
  return artifactPath;
}

export function formatWorkflowPlanStatus(state: WorkflowPlanState | undefined): string {
  if (!state) return "No workflow plan exists for this project.";
  const execution = state.execution
    ? `\n- Execution attempts: ${state.execution.attempts}\n- Verification: ${state.execution.verificationPassed ? "passed" : "not passed"}`
    : "";
  return `- Plan: **${state.id}**\n- Status: **${state.status}**\n- Task: ${state.task}\n- Plan file: ${state.planPath}\n- Review rounds: ${state.reviewRounds}${execution}`;
}
