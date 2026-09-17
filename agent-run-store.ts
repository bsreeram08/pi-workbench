import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const AGENT_RUN_RECORD_VERSION = 1 as const;
export const MAX_AGENT_RUN_RECORD_BYTES = 128 * 1024;
export const MAX_AGENT_RUN_OUTPUT_BYTES = 64 * 1024;
export const AGENT_RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type AgentRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "steering"
  | "waiting_for_parent"
  | "cancelling"
  | "terminating"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "orphaned";

export interface AgentRunQuestion {
  readonly id: string;
  readonly rpcRequestId: string;
  readonly toolCallId: string;
  readonly question: string;
  readonly askedAt: string;
  readonly answeredAt?: string;
}

export interface AgentRunRecord {
  readonly version: typeof AGENT_RUN_RECORD_VERSION;
  readonly runId: string;
  readonly agentId: string;
  readonly title: string;
  readonly projectRoot: string;
  readonly memoryProjectRoot?: string;
  readonly cwd: string;
  readonly groupId: string;
  readonly status: AgentRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sequence: number;
  readonly taskDigest: string;
  readonly systemPromptDigest: string;
  readonly trustedCodeDigest: string;
  readonly runtime?: "headless-rpc" | "interactive-tui";
  readonly runtimePath?: string;
  readonly runtimeDigest?: string;
  readonly tools: readonly string[];
  readonly readOnly: boolean;
  readonly allowBash: boolean;
  readonly model?: string;
  readonly thinking?: string;
  readonly budget?: { readonly turns: number; readonly tools: number };
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly processStartIdentity?: string;
  readonly question?: AgentRunQuestion;
  readonly questionUsed?: boolean;
  readonly outputDigest?: string;
  readonly exitCode?: number;
  readonly errorCode?: string;
  readonly checksum: string;
}

export interface AgentRunPaths {
  readonly root: string;
  readonly record: string;
  readonly systemPrompt: string;
  readonly finalText: string;
  readonly sessions: string;
  readonly temporaryHome: string;
  readonly temporaryDirectory: string;
}

const RECORD_KEYS = new Set([
  "version", "runId", "agentId", "title", "projectRoot", "memoryProjectRoot", "cwd", "groupId", "status",
  "createdAt", "updatedAt", "sequence", "taskDigest", "systemPromptDigest", "trustedCodeDigest", "runtime", "runtimePath", "runtimeDigest",
  "tools", "readOnly", "allowBash", "model", "thinking", "budget", "sessionDir", "sessionFile",
  "sessionId", "pid", "processStartIdentity", "question", "questionUsed", "outputDigest", "exitCode", "errorCode", "checksum",
]);
const QUESTION_KEYS = new Set(["id", "rpcRequestId", "toolCallId", "question", "askedAt", "answeredAt"]);
const BUDGET_KEYS = new Set(["turns", "tools"]);
const STATUSES = new Set<AgentRunStatus>([
  "queued", "starting", "running", "steering", "waiting_for_parent", "cancelling", "terminating",
  "completed", "failed", "cancelled", "interrupted", "orphaned",
]);
const RUN_ID_PATTERN = AGENT_RUN_ID_PATTERN;

export function isAgentRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
const writes = new Map<string, Promise<void>>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function computeAgentRunChecksum(record: Omit<AgentRunRecord, "checksum"> | AgentRunRecord): string {
  const { checksum: _checksum, ...material } = record as AgentRunRecord;
  return digest(material);
}

export function digestAgentRunText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function canonicalAbsolute(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value;
}

function validQuestion(value: unknown): value is AgentRunQuestion {
  if (!isRecord(value) || !hasOnlyKeys(value, QUESTION_KEYS)) return false;
  return typeof value.id === "string" && RUN_ID_PATTERN.test(value.id)
    && typeof value.rpcRequestId === "string" && value.rpcRequestId.length <= 256
    && typeof value.toolCallId === "string" && value.toolCallId.length <= 256
    && typeof value.question === "string" && value.question.length > 0 && value.question.length <= 4_000
    && canonicalIso(value.askedAt)
    && (value.answeredAt === undefined || canonicalIso(value.answeredAt));
}

function validBudget(value: unknown): value is { turns: number; tools: number } {
  return isRecord(value) && hasOnlyKeys(value, BUDGET_KEYS)
    && Number.isSafeInteger(value.turns) && (value.turns as number) > 0 && (value.turns as number) <= 1_000
    && Number.isSafeInteger(value.tools) && (value.tools as number) > 0 && (value.tools as number) <= 10_000;
}

export function isAgentRunRecord(value: unknown): value is AgentRunRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) return false;
  const item = value as Record<string, unknown>;
  if (item.version !== AGENT_RUN_RECORD_VERSION
    || typeof item.runId !== "string" || !RUN_ID_PATTERN.test(item.runId)
    || typeof item.agentId !== "string" || !RUN_ID_PATTERN.test(item.agentId)
    || typeof item.title !== "string" || item.title.length < 1 || item.title.length > 160
    || !canonicalAbsolute(item.projectRoot) || (item.memoryProjectRoot !== undefined && !canonicalAbsolute(item.memoryProjectRoot)) || !canonicalAbsolute(item.cwd)
    || typeof item.groupId !== "string" || !RUN_ID_PATTERN.test(item.groupId)
    || typeof item.status !== "string" || !STATUSES.has(item.status as AgentRunStatus)
    || !canonicalIso(item.createdAt) || !canonicalIso(item.updatedAt)
    || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0
    || typeof item.taskDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.taskDigest)
    || typeof item.systemPromptDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.systemPromptDigest)
    || typeof item.trustedCodeDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.trustedCodeDigest)
    || (item.runtime !== undefined && item.runtime !== "headless-rpc" && item.runtime !== "interactive-tui")
    || (item.runtimePath !== undefined && !canonicalAbsolute(item.runtimePath))
    || (item.runtimeDigest !== undefined && (typeof item.runtimeDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.runtimeDigest)))
    || !Array.isArray(item.tools) || item.tools.length > 64 || item.tools.some((tool) => typeof tool !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool))
    || typeof item.readOnly !== "boolean" || typeof item.allowBash !== "boolean"
    || (item.model !== undefined && (typeof item.model !== "string" || item.model.length > 256))
    || (item.thinking !== undefined && (typeof item.thinking !== "string" || item.thinking.length > 32))
    || (item.budget !== undefined && !validBudget(item.budget))
    || !canonicalAbsolute(item.sessionDir)
    || (item.sessionFile !== undefined && !canonicalAbsolute(item.sessionFile))
    || (item.sessionId !== undefined && (typeof item.sessionId !== "string" || item.sessionId.length > 256))
    || (item.pid !== undefined && (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0))
    || (item.processStartIdentity !== undefined && (typeof item.processStartIdentity !== "string" || item.processStartIdentity.length > 512))
    || (item.question !== undefined && !validQuestion(item.question))
    || (item.questionUsed !== undefined && typeof item.questionUsed !== "boolean")
    || (item.outputDigest !== undefined && (typeof item.outputDigest !== "string" || !/^[0-9a-f]{64}$/.test(item.outputDigest)))
    || (item.exitCode !== undefined && (!Number.isSafeInteger(item.exitCode) || (item.exitCode as number) < -1 || (item.exitCode as number) > 255))
    || (item.errorCode !== undefined && (typeof item.errorCode !== "string" || !/^[a-z0-9_.-]{1,128}$/.test(item.errorCode)))
    || typeof item.checksum !== "string" || !/^[0-9a-f]{64}$/.test(item.checksum)) return false;
  return item.checksum === computeAgentRunChecksum(item as unknown as AgentRunRecord);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe agent-run directory: ${directory}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await fs.chmod(directory, 0o700);
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const previous = writes.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  writes.set(filePath, queued);
  await previous;
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, filePath);
    const directory = await fs.open(path.dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    release();
    if (writes.get(filePath) === queued) writes.delete(filePath);
  }
}

export class AgentRunStore {
  readonly root: string;

  constructor(root = path.join(getAgentDir(), "workbench", "agent-runs", `v${AGENT_RUN_RECORD_VERSION}`)) {
    this.root = path.resolve(root);
  }

  async paths(projectRoot: string, runId: string): Promise<AgentRunPaths> {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid agent run id.");
    const canonicalProject = await fs.realpath(projectRoot);
    const projectKey = digest(canonicalProject).slice(0, 32);
    const root = path.join(this.root, projectKey, runId);
    return {
      root,
      record: path.join(root, "record.json"),
      systemPrompt: path.join(root, "system-prompt.md"),
      finalText: path.join(root, "final-text.md"),
      sessions: path.join(root, "sessions"),
      temporaryHome: path.join(root, "home"),
      temporaryDirectory: path.join(root, "tmp"),
    };
  }

  async prepare(projectRoot: string, runId: string): Promise<AgentRunPaths> {
    const paths = await this.paths(projectRoot, runId);
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(path.dirname(paths.root));
    await ensurePrivateDirectory(paths.root);
    await ensurePrivateDirectory(paths.sessions);
    await ensurePrivateDirectory(paths.temporaryHome);
    await ensurePrivateDirectory(paths.temporaryDirectory);
    return paths;
  }

  async writeSystemPrompt(paths: AgentRunPaths, content: string): Promise<void> {
    await atomicWrite(paths.systemPrompt, content);
  }

  async writeFinalText(paths: AgentRunPaths, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_AGENT_RUN_OUTPUT_BYTES) {
      throw new Error("Agent-run output exceeds its size limit.");
    }
    await atomicWrite(paths.finalText, content);
  }

  async loadFinalText(paths: AgentRunPaths, expectedDigest?: string): Promise<string> {
    let stat;
    try { stat = await fs.lstat(paths.finalText); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Stored specialist output is missing.");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_RUN_OUTPUT_BYTES) {
      throw new Error("Stored specialist output is unsafe or oversized.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Stored specialist output permissions are not private.");
    const text = await fs.readFile(paths.finalText, "utf8");
    if (expectedDigest && digestAgentRunText(text) !== expectedDigest) {
      throw new Error("Stored specialist output failed digest check.");
    }
    return text;
  }

  async save(paths: AgentRunPaths, record: Omit<AgentRunRecord, "checksum"> | AgentRunRecord): Promise<AgentRunRecord> {
    const { checksum: _checksum, ...material } = record as AgentRunRecord;
    const finalized = { ...material, checksum: computeAgentRunChecksum(material) } as AgentRunRecord;
    if (!isAgentRunRecord(finalized)) throw new Error("Refusing to persist an invalid agent-run record.");
    const serialized = `${JSON.stringify(finalized, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_AGENT_RUN_RECORD_BYTES) throw new Error("Agent-run record exceeds its size limit.");
    await atomicWrite(paths.record, serialized);
    return finalized;
  }

  async load(projectRoot: string, runId: string): Promise<AgentRunRecord | undefined> {
    const paths = await this.paths(projectRoot, runId);
    let stat;
    try { stat = await fs.lstat(paths.record); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENT_RUN_RECORD_BYTES) {
      throw new Error(`Unsafe or oversized agent-run record: ${runId}`);
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Agent-run record permissions are not private: ${runId}`);
    const parsed = JSON.parse(await fs.readFile(paths.record, "utf8")) as unknown;
    if (!isAgentRunRecord(parsed)) throw new Error(`Agent-run record failed integrity validation: ${runId}`);
    return parsed;
  }

  async list(projectRoot: string): Promise<AgentRunRecord[]> {
    const canonicalProject = await fs.realpath(projectRoot);
    const projectKey = digest(canonicalProject).slice(0, 32);
    const directory = path.join(this.root, projectKey);
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: AgentRunRecord[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_ID_PATTERN.test(entry.name)) continue;
      const record = await this.load(canonicalProject, entry.name);
      if (record) records.push(record);
    }
    return records;
  }
}

export function defaultAgentRunStoreRoot(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "workbench", "agent-runs", `v${AGENT_RUN_RECORD_VERSION}`);
}
