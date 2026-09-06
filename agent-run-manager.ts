import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AgentRpcConnection, AgentRpcProtocolError, MAX_AGENT_RPC_STDERR_BYTES, type AgentRpcEvent, type RpcResponse } from "./agent-rpc.ts";
import { AgentRunStore, digestAgentRunText, type AgentRunPaths, type AgentRunQuestion, type AgentRunRecord, type AgentRunStatus } from "./agent-run-store.ts";
import { CHILD_BRIDGE_EXTENSION_PATH, type AgentSessionHost } from "./agent-cmux-session.ts";
import { supportsFastModeRoute } from "./child-fast-mode.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";
import { inspectProcessStart } from "./exclusive-lease.ts";
import type { AgentResult, AgentSpec } from "./types.ts";
import { validateCheckReceipt, validateCheckRequest, workspaceSnapshot, type CheckRequest, type CheckReceipt } from "./verification.ts";
import { buildAgentContext } from "./agent-context.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const CHILD_TOOLS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-tools.ts");
const CHILD_FAST_MODE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "child-fast-mode.ts");
const TRUSTED_CHILD_FILES = [
  "agent-child-bridge.ts", "agent-cmux-bridge.mjs", "agent-cmux-session.ts", "child-fast-mode.ts", "child-tools.ts",
  "memory-access.ts", "memory-store.ts", "memory.ts", "readonly-bash.ts", "research-tools.ts", "research-types.ts", "research-browser.mjs",
  "verification.ts", "verification-tool.ts",
];
const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "failed", "cancelled", "interrupted", "orphaned"]);
const MAX_QUESTION_BYTES = 4_000;
let fallbackSequence = 0;

export type AgentRunProgress = (message: string) => void;

export interface AgentRunContext {
  /** Only native leased writer actions may set this task authority binding. */
  writerBinding?: { planId: string; taskDigest: string };
  continuation?: { runId: string; expectedWorkspaceSnapshot: string };
  dashboard?: WorkbenchDashboardController;
  groupId?: string;
  groupTitle?: string;
  jobId?: string;
  memoryProjectRoot?: string;
  budget?: { turns: number; tools: number };
  allowParentQuestions?: boolean;
  contextTask?: string;
}

export interface AgentRunRequest {
  readonly projectRoot: string;
  readonly agent: AgentSpec;
  readonly systemPrompt: string;
  readonly task: string;
  readonly signal?: AbortSignal;
  readonly progress?: AgentRunProgress;
  readonly runContext?: AgentRunContext;
  readonly runId?: string;
}

export interface AgentRunHandle {
  readonly runId: string;
  readonly completion: Promise<AgentResult>;
}

export interface AgentRunStatusView {
  readonly runId: string;
  readonly agentId: string;
  readonly title: string;
  readonly status: AgentRunStatus;
  readonly sequence: number;
  readonly model?: string;
  readonly sessionPresent: boolean;
  readonly question?: { id: string; question: string; askedAt: string };
  readonly exitCode?: number;
  readonly errorCode?: string;
}

export interface AgentRunManagerOptions {
  readonly dashboard?: WorkbenchDashboardController;
  readonly store?: AgentRunStore;
  readonly sessionHost?: AgentSessionHost;
  readonly spawnProcess?: typeof spawn;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly invocation?: (args: string[]) => { command: string; args: string[] };
  readonly environment?: NodeJS.ProcessEnv;
  readonly defaultModel?: string;
  readonly defaultFastMode?: boolean;
  readonly terminationGraceMs?: number;
  readonly killGraceMs?: number;
}

interface ActiveRun {
  lifecycleEpoch: number;
  continuationPromptDispatched?: boolean;
  continuationTurnStarted?: boolean;
  continuationFreshAssistant?: boolean;
  continuationDepth?: number;
  readonly request: AgentRunRequest;
  readonly paths: AgentRunPaths;
  readonly child: ChildProcessWithoutNullStreams;
  readonly rpc: AgentRpcConnection;
  readonly completion: Promise<AgentResult>;
  readonly resolve: (result: AgentResult) => void;
  readonly reject: (error: Error) => void;
  record: AgentRunRecord;
  persistChain: Promise<void>;
  stderr: string;
  latestAssistant: string;
  currentAssistant: string;
  lastStopReason?: string;
  settledStopReason?: string;
  currentAskToolCallId?: string;
  questionAdmissionLocked: boolean;
  answerInFlight: boolean;
  validatedFinalText?: string;
  loadoutVerified: boolean;
  readonly loadoutReady: Promise<void>;
  readonly resolveLoadout: () => void;
  readonly rejectLoadout: (error: Error) => void;
  promptAccepted: boolean;
  settledSeen: boolean;
  finalHandshakeDone: boolean;
  protocolFailure?: AgentRpcProtocolError;
  extensionFailure?: string;
  budgetFailure?: string;
  cancellationRequested: boolean;
  terminationRequested: boolean;
  closed: boolean;
  closeCode?: number;
  assistantTurns: number;
  toolCalls: number;
  synthesisQueued: boolean;
  checkRequests: Map<string, CheckRequest>;
  checkReceipts: Array<{ value: unknown; request: CheckRequest }>;
  readonly interactive: boolean;
  readonly routeModel?: string;
  terminationTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

interface ClosedWriterCheckpoint {
  readonly record: AgentRunRecord;
  readonly binding: { planId: string; taskDigest: string };
  readonly sourcePromptDigest: string;
  readonly transcript: Buffer;
  readonly transcriptDigest: string;
  readonly snapshot: string;
  readonly depth: number;
  readonly fastMode: boolean;
}

async function readWriterTranscript(record: AgentRunRecord): Promise<Buffer> {
  if (!record.sessionFile || !record.sessionId) throw new Error("Writer session checkpoint is missing.");
  const root = await fs.lstat(record.sessionDir);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
    || !containedPath(await fs.realpath(record.sessionDir), await fs.realpath(record.sessionFile))) throw new Error("Writer session root is unsafe.");
  const handle = await fs.open(record.sessionFile, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW | fsSync.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0) throw new Error("Writer transcript is not a bounded private regular file.");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let count = 0;
    while (count < buffer.length) {
      const chunk = await handle.read(buffer, count, buffer.length - count, count);
      if (!chunk.bytesRead) break;
      count += chunk.bytesRead;
    }
    if (count > 2 * 1024 * 1024) throw new Error("Writer transcript exceeds its size limit.");
    const content = buffer.subarray(0, count);
    const lines = content.toString("utf8").trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = entries[0];
    if (!header || header.type !== "session" || header.id !== record.sessionId || header.cwd !== record.projectRoot) throw new Error("Writer transcript identity does not match its checkpoint.");
    return Buffer.from(content);
  } finally { await handle.close(); }
}

function splitModel(value: string | undefined): { model?: string; thinking?: string; identity?: string } {
  if (!value) return {};
  const match = value.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/);
  return match ? { model: value, thinking: match[2], identity: match[1] } : { model: value, identity: value };
}

function truncate(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_OUTPUT_BYTES) return text;
  let result = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) result = result.slice(0, -1);
  return `${result}\n\n[Agent output truncated at 50KB.]`;
}

function boundedAppend(current: string, chunk: string, maximum: number): string {
  if (Buffer.byteLength(current, "utf8") >= maximum) return current;
  const remaining = maximum - Buffer.byteLength(current, "utf8");
  let addition = chunk;
  while (Buffer.byteLength(addition, "utf8") > remaining) addition = addition.slice(0, -1);
  return current + addition;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "assistant" || !Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function extractToolText(result: unknown): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as any).content)) return "";
  return (result as any).content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function discoverFilesAndTests(toolName: string, args: Record<string, unknown>, command?: string): { files: string[]; tests: string[] } {
  const files = new Set<string>();
  const tests = new Set<string>();
  for (const key of ["path", "file_path", "filePath"]) if (typeof args[key] === "string") files.add(args[key] as string);
  if (toolName === "bash" && command) {
    for (const match of command.matchAll(/(?:bun|npm|pnpm|yarn|pytest|xcodebuild)\s+(?:run\s+)?(?:test|tests|check|build|lint|typecheck)\b[^;&|]*/g)) tests.add(match[0].trim());
    for (const match of command.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|swift|kt|java|py|rs|go))(?=$|\s)/g)) files.add(match[1]);
  }
  return { files: [...files], tests: [...tests] };
}

function requestedTools(agent: AgentSpec): string[] {
  const researchTools = agent.researchTools ? ["research_search", "research_fetch", "research_browser"] : [];
  const tools = agent.readOnly
    ? ["read", "grep", "find", "ls", "qmd_search", "workbench_memory", ...researchTools, ...(agent.allowBash ? ["bash"] : [])]
    : ["read", "write", "edit", "grep", "find", "ls", "bash", "qmd_search", "workbench_memory", ...researchTools];
  return [...new Set([...tools, "ask_parent", ...(!agent.readOnly || agent.allowBash ? ["workbench_verify"] : [])])];
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams | undefined, signal: NodeJS.Signals): void {
  if (!child) return;
  if (child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall through. */ }
  }
  try { child.kill(signal); } catch { /* The process may already have exited. */ }
}

export function defaultAgentInvocation(args: string[], executablePath = process.execPath): { command: string; args: string[] } {
  const executable = path.basename(executablePath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: executablePath, args };
  return { command: "pi", args };
}

function sanitizePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const entries = value.split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry) && !entry.includes("\0"));
  return entries.length ? entries.join(path.delimiter) : undefined;
}

export function buildAgentChildEnvironment(
  source: NodeJS.ProcessEnv,
  paths: AgentRunPaths,
  fields: { runId: string; agentId: string; projectRoot: string; memoryProjectRoot: string; toolBudget?: number; allowParentQuestions: boolean; expectedModel?: string; expectedThinking?: string; readOnly?: boolean },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: paths.temporaryHome,
    TMPDIR: paths.temporaryDirectory,
    PI_CODING_AGENT_DIR: source.PI_CODING_AGENT_DIR ?? getAgentDir(),
    PI_OFFLINE: "1",
    AI_AGENT: "pi",
    PI_CODING_AGENT: "true",
    PI_WORKBENCH_RUN_ID: fields.runId,
    PI_WORKBENCH_AGENT: fields.agentId,
    PI_WORKBENCH_PROJECT_ROOT: fields.projectRoot,
    PI_WORKBENCH_MEMORY_PROJECT_ROOT: fields.memoryProjectRoot,
    PI_WORKBENCH_TOOL_BUDGET: fields.toolBudget ? String(fields.toolBudget) : "",
    PI_WORKBENCH_ALLOW_PARENT_QUESTION: fields.allowParentQuestions ? "1" : "0",
    PI_WORKBENCH_EXPECTED_MODEL: fields.expectedModel ?? "",
    PI_WORKBENCH_EXPECTED_THINKING: fields.expectedThinking ?? "",
    PI_WORKBENCH_READ_ONLY: fields.readOnly === true ? "1" : "0",
    PI_WORKBENCH_EVIDENCE_DIR: path.join(paths.root, "checks"),
  };
  const term = source.TERM;
  if (term && /^[a-zA-Z0-9_.+-]{1,64}$/.test(term)) environment.TERM = term;
  const safePath = sanitizePath(source.PATH);
  if (safePath) environment.PATH = safePath;
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[key];
    if (value && /^[a-zA-Z0-9_.@-]{1,128}$/.test(value)) environment[key] = value;
  }
  return environment;
}

async function trustedCodeDigest(): Promise<string> {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  for (const name of [...TRUSTED_CHILD_FILES].sort()) {
    const file = path.join(root, name);
    hash.update(name).update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function resolveExecutable(command: string, environment: NodeJS.ProcessEnv): Promise<string> {
  if (path.isAbsolute(command)) return fs.realpath(command);
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try { return await fs.realpath(candidate); } catch { /* Continue searching. */ }
  }
  throw new Error(`Could not resolve the Pi runtime executable: ${command}`);
}

async function runtimeIdentity(invocation: { command: string; args: string[] }, environment: NodeJS.ProcessEnv): Promise<{ runtimePath: string; runtimeDigest: string }> {
  const executable = await resolveExecutable(invocation.command, environment);
  const scriptCandidate = invocation.args[0] && path.isAbsolute(invocation.args[0]) ? invocation.args[0] : undefined;
  let script: string | undefined;
  if (scriptCandidate) {
    try { script = await fs.realpath(scriptCandidate); } catch { script = undefined; }
  }
  const runtimePath = script ?? executable;
  const hash = createHash("sha256").update(script ? "script\0" : "executable\0").update(await fs.readFile(runtimePath));
  return { runtimePath, runtimeDigest: hash.digest("hex") };
}

function containedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function validateSessionCheckpoint(paths: AgentRunPaths, state: unknown): Promise<{ sessionFile: string; sessionId: string }> {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent state handshake is not an object.");
  }
  const value = state as Record<string, unknown>;
  if (value.isStreaming !== false || value.isCompacting !== false || value.pendingMessageCount !== 0) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent state was not fully settled at the final checkpoint.");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length < 1 || value.sessionId.length > 256) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session identity is missing or invalid.");
  }
  if (typeof value.sessionFile !== "string" || !path.isAbsolute(value.sessionFile)) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session file is missing or invalid.");
  }
  const rootStat = await fs.lstat(paths.sessions);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session root is not a private ordinary directory.");
  }
  const canonicalRoot = await fs.realpath(paths.sessions);
  const requestedFile = path.resolve(value.sessionFile);
  if (!containedPath(canonicalRoot, requestedFile)) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session file is outside the private session root.");
  }
  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(requestedFile, fsSync.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session checkpoint is not a regular file.");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  const fileStat = await fs.lstat(requestedFile);
  const canonicalFile = await fs.realpath(requestedFile);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o077) !== 0 || !containedPath(canonicalRoot, canonicalFile)) {
    throw new AgentRpcProtocolError("invalid_session_checkpoint", "Agent session checkpoint failed containment or privacy validation.");
  }
  return { sessionFile: canonicalFile, sessionId: value.sessionId };
}

function runIdPrefix(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 80);
  return normalized || "agent";
}

function normalizeErrorCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  return normalized || "agent-run-failed";
}

export class AgentRunManager {
  readonly store: AgentRunStore;
  private readonly active = new Map<string, ActiveRun>();
  private readonly recent = new Map<string, AgentRunRecord>();
  private readonly closedWriters = new Map<string, ClosedWriterCheckpoint>();
  private lifecycleEpoch = 0;
  private readonly sessionHost?: AgentSessionHost;
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly invocation: (args: string[]) => { command: string; args: string[] };
  private readonly environment: NodeJS.ProcessEnv;
  private defaultModel?: string;
  private readonly defaultFastMode: boolean;
  private readonly terminationGraceMs: number;
  private readonly killGraceMs: number;
  private dashboard?: WorkbenchDashboardController;

  constructor(options: AgentRunManagerOptions = {}) {
    this.dashboard = options.dashboard;
    this.store = options.store ?? new AgentRunStore();
    this.sessionHost = options.sessionHost;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.invocation = options.invocation ?? defaultAgentInvocation;
    this.environment = options.environment ?? process.env;
    this.defaultModel = options.defaultModel;
    this.defaultFastMode = options.defaultFastMode ?? true;
    this.terminationGraceMs = options.terminationGraceMs ?? 1_500;
    this.killGraceMs = options.killGraceMs ?? 5_000;
  }

  attachDashboard(dashboard: WorkbenchDashboardController): void {
    this.dashboard = dashboard;
  }

  setDefaultModel(model: string | undefined): void {
    this.defaultModel = model?.trim() || undefined;
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const lifecycleEpoch = this.lifecycleEpoch;
    let prior: ClosedWriterCheckpoint | undefined;
    if (request.runContext?.continuation) {
      const source = request.runContext.continuation.runId;
      prior = this.closedWriters.get(source);
      if (!prior) throw new Error("Writer continuation is unavailable, already consumed, or belongs to a previous parent session. Start a fresh bounded writer.");
      // Consume synchronously before any await: concurrent continuations cannot fork the checkpoint.
      this.closedWriters.delete(source);
      if (request.agent.readOnly || !request.runContext.writerBinding || prior.depth >= 3) throw new Error("Only completed bound writers may continue, for at most three repair turns.");
    }
    const projectRoot = await fs.realpath(request.projectRoot);
    const memoryProjectRoot = await fs.realpath(request.runContext?.memoryProjectRoot ?? projectRoot);
    const requestedRunId = request.runId ?? request.runContext?.jobId ?? `agent-${request.agent.id}`;
    const runId = `${runIdPrefix(requestedRunId)}-${this.uuid()}`;
    const paths = await this.store.prepare(projectRoot, runId);
    const context = await buildAgentContext({
      projectRoot, role: request.agent.id, task: request.runContext?.contextTask ?? request.task,
      agentDir: this.environment.PI_CODING_AGENT_DIR ?? getAgentDir(), home: this.environment.HOME ?? os.homedir(),
    });
    const systemPrompt = `${request.systemPrompt}\n\n${context}`;
    await this.store.writeSystemPrompt(paths, systemPrompt);
    const tools = requestedTools(request.agent);
    const interactive = this.sessionHost?.interactive === true;
    const routeModel = request.agent.model ?? this.defaultModel;
    if (interactive && !routeModel) throw new Error("Interactive Workbench agents require a resolved model route before launch.");
    const model = splitModel(routeModel);
    const fastMode = (request.agent.fastMode ?? this.defaultFastMode) && supportsFastModeRoute(model.identity);
    if (prior) {
      const binding = request.runContext!.writerBinding!;
      if (prior.record.projectRoot !== projectRoot || prior.record.memoryProjectRoot !== memoryProjectRoot
        || prior.binding.planId !== binding.planId || prior.binding.taskDigest !== binding.taskDigest
        || prior.record.agentId !== request.agent.id || prior.record.model !== routeModel
        || prior.record.allowBash !== (request.agent.allowBash === true)
        || JSON.stringify(prior.record.tools) !== JSON.stringify(tools)
        || prior.sourcePromptDigest !== digestAgentRunText(request.systemPrompt)
        || prior.record.systemPromptDigest !== digestAgentRunText(systemPrompt)
        || prior.record.runtime !== (interactive ? "interactive-tui" : "headless-rpc")
        || prior.fastMode !== fastMode
        || prior.record.trustedCodeDigest !== await trustedCodeDigest()) throw new Error("Writer continuation task, model, tools, instructions, or runtime binding changed.");
      const expected = request.runContext!.continuation!.expectedWorkspaceSnapshot;
      if (expected !== prior.snapshot || await workspaceSnapshot(projectRoot) !== prior.snapshot) throw new Error("Workspace changed since the writer checkpoint; inspect changes and start a fresh bounded writer.");
      if (digestAgentRunText((await readWriterTranscript(prior.record)).toString("utf8")) !== prior.transcriptDigest) throw new Error("Writer transcript changed after the process exited.");
    }
    const timestamp = this.now().toISOString();
    const baseRecord = await this.store.save(paths, {
      version: 1,
      runId,
      agentId: request.agent.id,
      title: request.agent.title,
      projectRoot,
      memoryProjectRoot,
      cwd: projectRoot,
      groupId: request.runContext?.groupId ?? "agents",
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      sequence: 0,
      taskDigest: digestAgentRunText(request.task),
      systemPromptDigest: digestAgentRunText(systemPrompt),
      trustedCodeDigest: await trustedCodeDigest(),
      runtime: interactive ? "interactive-tui" : "headless-rpc",
      tools,
      readOnly: request.agent.readOnly,
      allowBash: request.agent.allowBash === true,
      ...(model.model ? { model: model.model } : {}),
      ...(model.thinking ? { thinking: model.thinking } : {}),
      ...(request.runContext?.budget ? { budget: request.runContext.budget } : {}),
      sessionDir: paths.sessions,
    });
    this.recent.set(runId, baseRecord);

    let resolve!: (result: AgentResult) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<AgentResult>((ok, fail) => { resolve = ok; reject = fail; });
    const args = [
      ...(interactive ? [] : ["--mode", "rpc"]),
      "--session-dir", paths.sessions,
      ...(prior ? ["--session", path.join(paths.sessions, "continued-session.jsonl")] : interactive ? ["--session-id", runId] : []),
      "--no-extensions", "--extension", CHILD_TOOLS_PATH,
      ...(fastMode ? ["--extension", CHILD_FAST_MODE_PATH] : []),
      ...(interactive ? ["--extension", CHILD_BRIDGE_EXTENSION_PATH] : []),
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
      "--append-system-prompt", paths.systemPrompt,
      ...(routeModel ? ["--model", routeModel] : []),
      "--tools", tools.join(","),
    ];
    const piInvocation = this.invocation(args);
    const childEnvironment = buildAgentChildEnvironment(this.environment, paths, {
      runId,
      agentId: request.agent.id,
      projectRoot,
      memoryProjectRoot,
      toolBudget: request.runContext?.budget?.tools,
      allowParentQuestions: request.runContext?.allowParentQuestions === true,
      expectedModel: model.identity,
      expectedThinking: model.thinking,
      readOnly: request.agent.readOnly,
    });
    const runtime = await runtimeIdentity(piInvocation, childEnvironment);
    if (prior) {
      if (runtime.runtimePath !== prior.record.runtimePath || runtime.runtimeDigest !== prior.record.runtimeDigest) throw new Error("Writer continuation executable changed.");
      const restored = prior.transcript.toString("utf8").split("\n");
      // Clone context into a new session identity; old transcript is never mutated or replayed.
      const header = JSON.parse(restored[0]!) as Record<string, unknown>;
      restored[0] = JSON.stringify({ ...header, id: runId, timestamp: this.now().toISOString() });
      await fs.writeFile(path.join(paths.sessions, "continued-session.jsonl"), restored.join("\n"), { flag: "wx", mode: 0o600 });
    }
    let launch: { invocation: { command: string; args: readonly string[] }; environment: NodeJS.ProcessEnv };
    try {
      launch = this.sessionHost
        ? await this.sessionHost.prepare({ runId, agentId: request.agent.id, paths, projectRoot, task: request.task, piInvocation, childEnvironment })
        : { invocation: piInvocation, environment: childEnvironment };
    } catch (error) {
      const { checksum: _checksum, ...current } = baseRecord;
      const failed = await this.store.save(paths, {
        ...current,
        status: "failed",
        updatedAt: this.now().toISOString(),
        sequence: current.sequence + 1,
        exitCode: 1,
        errorCode: "interactive-launch-failed",
      });
      this.recent.set(runId, failed);
      throw error;
    }
    if (this.lifecycleEpoch !== lifecycleEpoch) throw new Error("Parent lifecycle changed before writer launch; start a fresh bounded assignment.");
    const child = this.spawnProcess(launch.invocation.command, [...launch.invocation.args], {
      cwd: projectRoot,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.environment,
    });

    const earlyEvents: AgentRpcEvent[] = [];
    let earlyProtocolFailure: AgentRpcProtocolError | undefined;
    let attached = false;
    const rpc = new AgentRpcConnection(child.stdin, child.stdout, {
      onEvent: (event) => attached ? this.onEvent(runId, event) : earlyEvents.push(event),
      onProtocolError: (error) => attached ? this.onProtocolFailure(runId, error) : (earlyProtocolFailure = error),
    });
    let resolveLoadout!: () => void;
    let rejectLoadout!: (error: Error) => void;
    const loadoutReady = new Promise<void>((ok, fail) => { resolveLoadout = ok; rejectLoadout = fail; });
    // The child can emit its loadout synchronously before startup persistence
    // reaches the later Promise.race. Observe early rejection immediately so
    // stricter runtimes do not classify that handled protocol failure as an
    // unhandled rejection; awaiting loadoutReady below still rejects normally.
    void loadoutReady.catch(() => undefined);
    const active: ActiveRun = {
      lifecycleEpoch,
      request: { ...request, projectRoot }, paths, child, rpc, completion, resolve, reject,
      record: baseRecord, persistChain: Promise.resolve(), stderr: "", latestAssistant: "", currentAssistant: "",
      questionAdmissionLocked: false, answerInFlight: false, loadoutVerified: false, loadoutReady, resolveLoadout, rejectLoadout,
      promptAccepted: false, settledSeen: false, finalHandshakeDone: false, cancellationRequested: false,
      terminationRequested: false, closed: false, assistantTurns: 0, toolCalls: 0, synthesisQueued: false, interactive, routeModel,
      checkRequests: new Map(), checkReceipts: [],
      continuationDepth: prior ? prior.depth + 1 : 0,
    };
    this.active.set(runId, active);
    child.stderr.on("data", (chunk: Buffer) => { active.stderr = boundedAppend(active.stderr, chunk.toString(), MAX_AGENT_RPC_STDERR_BYTES); });
    child.once("error", (error) => this.onProcessError(runId, error));
    child.once("close", (code) => { void this.onClose(runId, code ?? 1); });

    const dashboard = request.runContext?.dashboard ?? this.dashboard;
    const groupId = request.runContext?.groupId ?? "agents";
    const groupTitle = request.runContext?.groupTitle ?? "Agents";
    dashboard?.addJob(runId, request.agent.title, groupId, groupTitle);
    dashboard?.updateJob(runId, { status: "starting", latestActivity: interactive ? "Starting interactive Pi TUI" : "Starting persistent agent" });
    dashboard?.setControl(runId, {
      steer: (message) => { void this.message(runId, message, "steer"); },
      pause: () => this.pause(runId),
      resume: () => this.resume(runId),
      cancel: () => { void this.cancel(runId); },
      restart: () => { void this.cancel(runId); },
      answer: (questionId, value) => { void this.answer(runId, questionId, value); },
    });
    request.progress?.(`${request.agent.title} started`);
    attached = true;
    for (const event of earlyEvents) this.onEvent(runId, event);
    if (earlyProtocolFailure) this.onProtocolFailure(runId, earlyProtocolFailure);
    const processIdentity = child.pid ? await inspectProcessStart(child.pid) : undefined;
    if (active.closed) return { runId, completion };
    await this.transition(active, "starting", {
      runtimePath: runtime.runtimePath,
      runtimeDigest: runtime.runtimeDigest,
      ...(child.pid ? { pid: child.pid } : {}),
      ...(processIdentity?.startIdentity ? { processStartIdentity: processIdentity.startIdentity } : {}),
    });
    request.signal?.addEventListener("abort", () => { void this.cancel(runId); }, { once: true });
    if (request.signal?.aborted) {
      await this.cancel(runId);
      return { runId, completion };
    }

    try {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          active.loadoutReady,
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => reject(new AgentRpcProtocolError("loadout_timeout", "Timed out waiting for the child loadout handshake.")), 15_000);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (active.protocolFailure || active.closed) throw active.protocolFailure ?? new AgentRpcProtocolError("process_closed", "Agent closed before prompt acceptance.");
      active.continuationPromptDispatched = Boolean(request.runContext?.continuation);
      const response = await rpc.request({ type: "prompt", message: `Task: ${request.task}` }, 30_000);
      active.promptAccepted = response.success;
      if (!active.promptAccepted) throw new AgentRpcProtocolError("prompt_rejected", "Agent prompt was rejected before acceptance.");
    } catch (error) {
      this.onProtocolFailure(runId, error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("prompt_failed", String(error)));
    }
    return { runId, completion };
  }

  async runToResult(request: AgentRunRequest): Promise<AgentResult> {
    if (request.signal?.aborted) {
      return { agentId: request.agent.id, title: request.agent.title, output: "", exitCode: 1, cancelled: true, error: "Agent cancelled before launch." };
    }
    const handle = await this.start(request);
    return handle.completion;
  }

  async message(runId: string, message: string, behavior: "steer" | "follow_up" = "steer"): Promise<void> {
    const active = this.requireActive(runId);
    if (active.record.status === "waiting_for_parent") throw new Error("Answer the pending parent question instead of steering this run.");
    if (TERMINAL_STATUSES.has(active.record.status)) throw new Error(`Agent run is terminal: ${runId}`);
    const response = await active.rpc.request({ type: behavior, message });
    if (!response.success) throw new Error(`Agent ${behavior} was rejected.`);
    await this.transition(active, "steering");
    const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
    const job = dashboard?.state.getJob(runId);
    if (job) dashboard?.updateJob(runId, { status: "steering", latestActivity: "Steering message queued", queuedMessages: [...job.queuedMessages, message] });
  }

  async answer(runId: string, questionId: string, value: string): Promise<void> {
    const active = this.requireActive(runId);
    const question = active.record.question;
    if (active.record.status !== "waiting_for_parent" || !question) throw new Error("Agent run is not waiting for a parent answer.");
    if (question.id !== questionId) throw new Error("Parent answer does not match the active question.");
    if (active.answerInFlight || question.answeredAt) throw new Error("The parent answer is already being delivered.");
    if (!value.trim() || value.length > MAX_QUESTION_BYTES) throw new Error("Parent answer must be between 1 and 4000 characters.");
    active.answerInFlight = true;
    try {
      await this.persist(active, { question: { ...question, answeredAt: this.now().toISOString() } });
      active.rpc.notify({ type: "extension_ui_response", id: question.rpcRequestId, value: value.trim() });
      await this.persist(active, { question: undefined });
      const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
      dashboard?.updateJob(runId, { status: "running", latestActivity: "Parent answer delivered", question: undefined });
    } catch (error) {
      const failure = error instanceof AgentRpcProtocolError
        ? error
        : new AgentRpcProtocolError("answer_delivery_failed", error instanceof Error ? error.message : String(error));
      this.onProtocolFailure(runId, failure);
      throw failure;
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active || active.closed || TERMINAL_STATUSES.has(active.record.status)) return;
    if (active.cancellationRequested) return;
    active.cancellationRequested = true;
    const cancellationPersistence = this.transition(active, "cancelling");
    const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
    dashboard?.updateJob(runId, { status: "cancelling", latestActivity: "Cancellation requested" });
    active.rpc.request({ type: "abort" }, this.terminationGraceMs).catch(() => undefined);
    active.terminationTimer = setTimeout(() => {
      if (active.closed) return;
      active.terminationRequested = true;
      void this.transition(active, "terminating").catch(() => undefined);
      signalProcessGroup(active.child, "SIGTERM");
    }, this.terminationGraceMs);
    active.terminationTimer.unref();
    active.killTimer = setTimeout(() => {
      if (!active.closed) signalProcessGroup(active.child, "SIGKILL");
    }, this.terminationGraceMs + this.killGraceMs);
    active.killTimer.unref();
    await cancellationPersistence;
  }

  pause(runId: string): void {
    const active = this.active.get(runId);
    if (!active || active.closed || active.cancellationRequested) return;
    if (active.interactive) {
      (active.request.runContext?.dashboard ?? this.dashboard)?.updateJob(runId, { status: "running", latestActivity: "Pause unavailable for interactive Pi TUI" });
      return;
    }
    signalProcessGroup(active.child, "SIGSTOP");
    (active.request.runContext?.dashboard ?? this.dashboard)?.updateJob(runId, { status: "paused", latestActivity: "Process suspended" });
  }

  resume(runId: string): void {
    const active = this.active.get(runId);
    if (!active || active.closed || active.cancellationRequested) return;
    if (active.interactive) {
      (active.request.runContext?.dashboard ?? this.dashboard)?.updateJob(runId, { status: "running", latestActivity: "Resume unavailable for interactive Pi TUI" });
      return;
    }
    signalProcessGroup(active.child, "SIGCONT");
    (active.request.runContext?.dashboard ?? this.dashboard)?.updateJob(runId, { status: "running", latestActivity: "Process resumed" });
  }

  focus(runId: string): void {
    const active = this.active.get(runId);
    const dashboard = active?.request.runContext?.dashboard ?? this.dashboard;
    dashboard?.state.selectJob(runId);
    dashboard?.focusCards();
    try { this.sessionHost?.focus(runId); } catch { /* Presentation focus is non-authoritative. */ }
  }

  async status(projectRoot: string, runId?: string): Promise<AgentRunStatusView[]> {
    const records = runId
      ? [this.active.get(runId)?.record ?? this.recent.get(runId) ?? await this.store.load(projectRoot, runId)].filter(Boolean) as AgentRunRecord[]
      : await this.store.list(projectRoot);
    return records.map((record) => ({
      runId: record.runId,
      agentId: record.agentId,
      title: record.title,
      status: record.status,
      sequence: record.sequence,
      ...(record.model ? { model: record.model } : {}),
      sessionPresent: Boolean(record.sessionFile),
      ...(record.question ? { question: { id: record.question.id, question: record.question.question, askedAt: record.question.askedAt } } : {}),
      ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    }));
  }

  async recover(projectRoot: string): Promise<AgentRunRecord[]> {
    this.lifecycleEpoch++;
    this.closedWriters.clear();
    const records = await this.store.list(projectRoot);
    const recovered: AgentRunRecord[] = [];
    for (const record of records) {
      if (TERMINAL_STATUSES.has(record.status)) { this.recent.set(record.runId, record); continue; }
      const paths = await this.store.paths(projectRoot, record.runId);
      const process = record.pid ? await inspectProcessStart(record.pid) : { kind: "missing" as const };
      const liveOrphan = process.kind === "live" && Boolean(record.processStartIdentity) && process.startIdentity === record.processStartIdentity;
      const next = await this.store.save(paths, {
        ...record,
        status: liveOrphan ? "orphaned" : "interrupted",
        updatedAt: this.now().toISOString(),
        sequence: record.sequence + 1,
        errorCode: liveOrphan ? "parent-restarted-live-process" : "parent-restarted",
      });
      this.recent.set(record.runId, next);
      recovered.push(next);
    }
    return recovered;
  }

  async shutdown(): Promise<void> {
    this.lifecycleEpoch++;
    this.closedWriters.clear();
    const runs = [...this.active.entries()];
    await Promise.all(runs.map(([runId]) => this.cancel(runId)));
    const wait = Promise.allSettled(runs.map(([, active]) => active.completion));
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.terminationGraceMs + this.killGraceMs + 1_000);
      timer.unref();
    });
    await Promise.race([wait.then(() => undefined), timeout]);
    for (const [, active] of runs) if (!active.closed) signalProcessGroup(active.child, "SIGKILL");
  }

  private requireActive(runId: string): ActiveRun {
    const active = this.active.get(runId);
    if (!active) throw new Error(`Agent run is not active: ${runId}`);
    return active;
  }

  private async transition(active: ActiveRun, status: AgentRunStatus, patch: Partial<Omit<AgentRunRecord, "checksum" | "version" | "runId">> = {}): Promise<void> {
    await this.persist(active, { ...patch, status });
  }

  private async persist(active: ActiveRun, patch: Partial<Omit<AgentRunRecord, "checksum" | "version" | "runId">>): Promise<void> {
    const operation = active.persistChain.then(async () => {
      const { checksum: _checksum, ...current } = active.record;
      const material = {
        ...current,
        ...patch,
        updatedAt: this.now().toISOString(),
        sequence: current.sequence + 1,
      } as Omit<AgentRunRecord, "checksum">;
      active.record = await this.store.save(active.paths, material);
      this.recent.set(active.record.runId, active.record);
    });
    active.persistChain = operation.catch((error) => {
      active.protocolFailure ??= new AgentRpcProtocolError("record_write_failed", error instanceof Error ? error.message : String(error));
      if (!active.closed) {
        signalProcessGroup(active.child, "SIGTERM");
        active.killTimer ??= setTimeout(() => { if (!active.closed) signalProcessGroup(active.child, "SIGKILL"); }, this.killGraceMs);
        active.killTimer.unref();
      }
    });
    await operation;
  }

  private onEvent(runId: string, event: AgentRpcEvent): void {
    const active = this.active.get(runId);
    if (!active || active.closed) return;
    if (active.settledSeen && event.type !== "agent_settled" && event.type !== "extension_error") return;
    const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
    const job = dashboard?.state.getJob(runId);
    if (event.type === "agent_start") {
      if (active.continuationPromptDispatched) {
        active.continuationTurnStarted = true;
        active.continuationFreshAssistant = false;
      }
      void this.transition(active, "running").catch((error) => this.onProtocolFailure(runId, new AgentRpcProtocolError("record_write_failed", error instanceof Error ? error.message : String(error))));
      dashboard?.updateJob(runId, { status: "running", startedAt: job?.startedAt ?? Date.now(), latestActivity: "Agent started" });
      return;
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") active.currentAssistant += delta.delta;
      dashboard?.updateJob(runId, { status: "running", output: truncate(active.currentAssistant), latestActivity: "Generating response" });
      return;
    }
    if (event.type === "message_end" && event.message) {
      const text = extractAssistantText(event.message);
      if (text && !active.settledSeen) {
        active.latestAssistant = text;
        active.currentAssistant = text;
        dashboard?.addTranscript(runId, { kind: "assistant", text, timestamp: Date.now() });
        dashboard?.updateJob(runId, { output: truncate(text), latestActivity: "Assistant message complete" });
      }
      const message = event.message as Record<string, unknown>;
      if (message.role === "assistant" && !active.settledSeen) {
        if (active.continuationTurnStarted && text.trim()) active.continuationFreshAssistant = true;
        active.assistantTurns++;
        if (typeof message.stopReason === "string") active.lastStopReason = message.stopReason;
        this.enforceBudget(active);
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      active.toolCalls++;
      const args = event.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args as Record<string, unknown> : {};
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `${Date.now()}`;
      if (toolName === "workbench_verify") {
        try {
          validateCheckRequest(args as unknown as CheckRequest);
          if (!active.record.tools.includes(toolName) || active.checkRequests.has(toolCallId)) throw new Error("Unexpected or duplicate verification invocation.");
          active.checkRequests.set(toolCallId, structuredClone(args) as unknown as CheckRequest);
        } catch (error) {
          this.onProtocolFailure(runId, new AgentRpcProtocolError("invalid_check", String(error)));
          return;
        }
      }
      if (toolName === "ask_parent") {
        if (typeof event.toolCallId !== "string" || event.toolCallId.length < 1 || event.toolCallId.length > 256) {
          this.onProtocolFailure(runId, new AgentRpcProtocolError("invalid_question_tool_call", "ask_parent tool call identity is invalid."));
          return;
        }
        active.currentAskToolCallId = toolCallId;
      }
      const discovered = discoverFilesAndTests(toolName, args, typeof args.command === "string" ? args.command : undefined);
      dashboard?.addTool(runId, { id: toolCallId, name: toolName, args, startedAt: Date.now() });
      dashboard?.updateJob(runId, {
        status: "running", latestActivity: `${toolName} running`,
        files: [...new Set([...(job?.files ?? []), ...discovered.files])],
        tests: [...new Set([...(job?.tests ?? []), ...discovered.tests])],
      });
      this.enforceBudget(active);
      return;
    }
    if (event.type === "tool_execution_update") {
      const output = extractToolText(event.partialResult);
      dashboard?.addTool(runId, { id: String(event.toolCallId ?? "tool"), name: String(event.toolName ?? "tool"), args: (event.args as Record<string, unknown>) ?? {}, output });
      return;
    }
    if (event.type === "tool_execution_end") {
      const toolCallId = String(event.toolCallId ?? "tool");
      const toolName = String(event.toolName ?? "tool");
      if (toolName === "workbench_verify") {
        const request = active.checkRequests.get(toolCallId);
        active.checkRequests.delete(toolCallId);
        if (!request) {
          this.onProtocolFailure(runId, new AgentRpcProtocolError("unmatched_check", "Verification result has no matching invocation."));
          return;
        }
        if (event.isError !== true) {
          const result = event.result as { details?: { receipt?: unknown } } | undefined;
          active.checkReceipts.push({ value: result?.details?.receipt, request });
        }
      }
      dashboard?.addTool(runId, { id: toolCallId, name: toolName, args: (event.args as Record<string, unknown>) ?? {}, output: extractToolText(event.result), isError: event.isError === true, finishedAt: Date.now() });
      if (active.currentAskToolCallId === toolCallId) {
        active.currentAskToolCallId = undefined;
        if (active.record.status === "waiting_for_parent") {
          void this.transition(active, "running", { question: undefined }).catch((error) => this.onProtocolFailure(runId, new AgentRpcProtocolError("record_write_failed", error instanceof Error ? error.message : String(error))));
        }
      }
      return;
    }
    if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.filter((item): item is string => typeof item === "string") : [];
      dashboard?.state.setQueuedMessages(runId, steering);
      return;
    }
    if (event.type === "extension_error") {
      active.extensionFailure = typeof event.error === "string" ? event.error : "Child extension failed.";
      dashboard?.updateJob(runId, { status: "failed", error: active.extensionFailure, latestActivity: "Extension error" });
      return;
    }
    if (event.type === "extension_ui_request") {
      void this.onUiRequest(active, event).catch((error) => this.onProtocolFailure(
        runId,
        error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("ui_request_failed", error instanceof Error ? error.message : String(error)),
      ));
      return;
    }
    if (event.type === "agent_settled") {
      const eventStopReason = typeof event.stopReason === "string" ? event.stopReason : active.lastStopReason;
      if (eventStopReason === "aborted" && active.interactive && !active.cancellationRequested) {
        active.lastStopReason = undefined;
        active.currentAssistant = "";
        void this.transition(active, "running").catch((error) => this.onProtocolFailure(runId, new AgentRpcProtocolError("record_write_failed", String(error))));
        dashboard?.updateJob(runId, { status: "running", latestActivity: "Interactive Pi TUI waiting for input" });
        return;
      }
      if (active.settledSeen) { this.onProtocolFailure(runId, new AgentRpcProtocolError("duplicate_settled", "Agent emitted agent_settled more than once.")); return; }
      active.settledSeen = true;
      active.settledStopReason = eventStopReason;
      if (!active.cancellationRequested) void this.finalHandshake(active);
    }
  }

  private async onUiRequest(active: ActiveRun, event: AgentRpcEvent): Promise<void> {
    if (event.method === "setStatus" && event.statusKey === "pi-workbench-child-loadout") {
      try {
        if (active.loadoutVerified) throw new AgentRpcProtocolError("duplicate_loadout", "Child emitted more than one loadout handshake.");
        if (typeof event.statusText !== "string" || Buffer.byteLength(event.statusText, "utf8") > 8_192) {
          throw new AgentRpcProtocolError("invalid_loadout", "Child loadout handshake is missing or oversized.");
        }
        const payload = JSON.parse(event.statusText) as unknown;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AgentRpcProtocolError("invalid_loadout", "Child loadout handshake is not an object.");
        const value = payload as Record<string, unknown>;
        if (Object.keys(value).some((key) => !["version", "runId", "activeTools", "model", "thinking"].includes(key))
          || value.version !== 1 || value.runId !== active.record.runId
          || !Array.isArray(value.activeTools) || value.activeTools.some((tool) => typeof tool !== "string")
          || (value.model !== undefined && typeof value.model !== "string")
          || (value.thinking !== undefined && typeof value.thinking !== "string")) {
          throw new AgentRpcProtocolError("invalid_loadout", "Child loadout handshake shape or run identity is invalid.");
        }
        const actual = [...new Set(value.activeTools as string[])].sort();
        const expected = [...active.record.tools].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new AgentRpcProtocolError("loadout_mismatch", "Child active tools do not match the persisted exact loadout.");
        }
        if (active.interactive || active.request.runContext?.writerBinding) {
          const expectedRoute = splitModel(active.routeModel);
          if (!expectedRoute.identity || value.model !== expectedRoute.identity
            || (expectedRoute.thinking !== undefined && value.thinking !== expectedRoute.thinking)) {
            throw new AgentRpcProtocolError("loadout_mismatch", "Child model or thinking level does not match the requested route.");
          }
        }
        active.loadoutVerified = true;
        active.resolveLoadout();
        return;
      } catch (error) {
        const failure = error instanceof AgentRpcProtocolError
          ? error
          : new AgentRpcProtocolError("invalid_loadout", `Child loadout handshake could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        active.rejectLoadout(failure);
        this.onProtocolFailure(active.record.runId, failure);
        return;
      }
    }
    if (event.method !== "input" || !active.currentAskToolCallId || active.request.runContext?.allowParentQuestions !== true) {
      this.onProtocolFailure(active.record.runId, new AgentRpcProtocolError("unexpected_ui_request", "Unexpected child extension UI request."));
      return;
    }
    if (active.questionAdmissionLocked || active.record.question || active.record.questionUsed || active.answerInFlight) {
      this.onProtocolFailure(active.record.runId, new AgentRpcProtocolError("multiple_questions", "Agent requested more than one parent answer for this run."));
      return;
    }
    const questionText = typeof event.message === "string"
      ? event.message
      : typeof event.placeholder === "string"
        ? event.placeholder
        : typeof event.title === "string" ? event.title : "Agent needs input";
    if (!questionText.trim() || Buffer.byteLength(questionText, "utf8") > MAX_QUESTION_BYTES) {
      this.onProtocolFailure(active.record.runId, new AgentRpcProtocolError("invalid_question", "Agent parent question is empty or oversized."));
      return;
    }
    active.questionAdmissionLocked = true;
    const question: AgentRunQuestion = {
      id: `question-${this.uuid()}`,
      rpcRequestId: String(event.id),
      toolCallId: active.currentAskToolCallId,
      question: questionText.trim(),
      askedAt: this.now().toISOString(),
    };
    await this.transition(active, "waiting_for_parent", { question, questionUsed: true });
    const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
    dashboard?.addTranscript(active.record.runId, { kind: "system", text: `Parent question: ${question.question}`, timestamp: Date.now() });
    dashboard?.updateJob(active.record.runId, {
      status: "waiting_for_parent", latestActivity: "Waiting for parent answer", question: { id: question.id, text: question.question },
    });
  }

  private enforceBudget(active: ActiveRun): void {
    const budget = active.request.runContext?.budget;
    if (!budget || active.budgetFailure) return;
    const requestSynthesis = (reason: string) => {
      if (active.synthesisQueued) return;
      active.synthesisQueued = true;
      active.rpc.request({
        type: "steer",
        message: `Read-only execution budget is nearly exhausted (${reason}). Stop exploring and return the best supported synthesis now. State unresolved uncertainty and the exact next verification step; do not call more tools.`,
      }).catch((error) => this.onProtocolFailure(active.record.runId, error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("budget_steer_failed", String(error))));
    };
    if (active.toolCalls >= Math.max(1, budget.tools - 5)) requestSynthesis(`${Math.min(active.toolCalls, budget.tools)}/${budget.tools} tool calls used`);
    if (active.assistantTurns >= budget.turns) requestSynthesis(`${active.assistantTurns}/${budget.turns} assistant turns used`);
    if (active.assistantTurns > budget.turns + 1) {
      active.budgetFailure = `Read-only assistant-turn budget exceeded (${budget.turns} turns plus one synthesis turn).`;
      void this.cancel(active.record.runId);
    }
  }

  private async finalHandshake(active: ActiveRun): Promise<void> {
    try {
      if (active.request.runContext?.continuation && !active.continuationFreshAssistant) {
        throw new AgentRpcProtocolError("missing_continuation_output", "Writer continuation settled without a fresh assistant response; prior transcript text is not a result.");
      }
      const [textResponse, stateResponse] = await Promise.all([
        active.rpc.request({ type: "get_last_assistant_text" }, 15_000),
        active.rpc.request({ type: "get_state" }, 15_000),
      ]);
      const text = (textResponse.data as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new AgentRpcProtocolError("invalid_final_text", "Final assistant text is missing or blank.");
      }
      const { sessionFile, sessionId } = await validateSessionCheckpoint(active.paths, stateResponse.data);
      active.validatedFinalText = text;
      active.latestAssistant = text;
      await this.persist(active, { sessionFile, sessionId });
      active.finalHandshakeDone = true;
      active.rpc.closeInput();
    } catch (error) {
      this.onProtocolFailure(active.record.runId, error instanceof AgentRpcProtocolError ? error : new AgentRpcProtocolError("final_handshake_failed", String(error)));
    }
  }

  private onProtocolFailure(runId: string, error: AgentRpcProtocolError): void {
    const active = this.active.get(runId);
    if (!active || active.closed || active.protocolFailure) return;
    active.protocolFailure = error;
    if (!active.loadoutVerified) active.rejectLoadout(error);
    void this.transition(active, "terminating", { errorCode: normalizeErrorCode(error.code) }).catch(() => undefined);
    signalProcessGroup(active.child, "SIGTERM");
    active.killTimer = setTimeout(() => { if (!active.closed) signalProcessGroup(active.child, "SIGKILL"); }, this.killGraceMs);
    active.killTimer.unref();
  }

  private onProcessError(runId: string, error: Error): void {
    this.onProtocolFailure(runId, new AgentRpcProtocolError("process_error", error.message));
  }

  private async onClose(runId: string, code: number): Promise<void> {
    const active = this.active.get(runId);
    if (!active || active.closed) return;
    active.closed = true;
    active.closeCode = code;
    if (active.terminationTimer) clearTimeout(active.terminationTimer);
    if (active.killTimer) clearTimeout(active.killTimer);
    active.rpc.rejectPending(new AgentRpcProtocolError("process_closed", "Agent process closed before an RPC response completed."));
    await active.persistChain;

    let status: AgentRunStatus;
    let errorCode: string | undefined;
    if (active.cancellationRequested) {
      status = "cancelled";
      errorCode = active.budgetFailure ? "budget-exceeded" : undefined;
    } else if (active.protocolFailure) {
      status = "failed";
      errorCode = normalizeErrorCode(active.protocolFailure.code);
    } else if (active.extensionFailure) {
      status = "failed";
      errorCode = "extension-error";
    } else if (code !== 0) {
      status = "failed";
      errorCode = "process-exit";
    } else if (!active.promptAccepted || !active.settledSeen || !active.finalHandshakeDone) {
      status = "failed";
      errorCode = "incomplete-handshake";
    } else if (["error", "aborted", "length"].includes(active.settledStopReason ?? "")) {
      status = "failed";
      errorCode = `assistant-${active.settledStopReason}`;
    } else if (!active.validatedFinalText?.trim()) {
      status = "failed";
      errorCode = "blank-result";
    } else {
      status = "completed";
    }

    let verification: AgentResult["verification"];
    if (status === "completed" && active.checkReceipts.length > 0) {
      try {
        if (active.checkRequests.size > 0) throw new Error("Verification commands have not settled.");
        const receipts: CheckReceipt[] = [];
        for (const { value, request } of active.checkReceipts) receipts.push(await validateCheckReceipt(value, request, {
          projectRoot: active.request.projectRoot, evidenceDir: path.join(active.paths.root, "checks"), runId,
        }));
        verification = { receipts, snapshot: await workspaceSnapshot(active.request.projectRoot) };
      } catch {
        status = "failed";
        errorCode = "invalid-check-evidence";
      }
    }
    const exactOutput = status === "completed"
      ? active.validatedFinalText!
      : active.validatedFinalText || active.latestAssistant || active.currentAssistant || active.stderr;
    const output = truncate(exactOutput);
    let terminalPersistenceError: Error | undefined;
    try {
      await this.transition(active, status, {
        exitCode: status === "completed" ? 0 : Math.max(1, code),
        ...(exactOutput ? { outputDigest: digestAgentRunText(exactOutput) } : {}),
        ...(errorCode ? { errorCode } : {}),
        question: undefined,
      });
    } catch (error) {
      terminalPersistenceError = error instanceof Error ? error : new Error(String(error));
      status = "failed";
      errorCode = "record-write-failed";
    }
    const result: AgentResult = {
      runId,
      agentId: active.request.agent.id,
      title: active.request.agent.title,
      output,
      exitCode: status === "completed" ? 0 : Math.max(1, code),
      ...(verification ? { verification } : {}),
      ...(status === "cancelled" ? { cancelled: true } : {}),
      ...(status !== "completed" ? { error: terminalPersistenceError?.message || active.protocolFailure?.message || active.extensionFailure || active.budgetFailure || active.stderr || errorCode || "Agent run failed." } : {}),
    };
    if (status === "completed" && active.lifecycleEpoch === this.lifecycleEpoch && !active.request.agent.readOnly && active.request.runContext?.writerBinding && active.routeModel) {
      try {
        const transcript = await readWriterTranscript(active.record);
        const snapshot = await workspaceSnapshot(active.record.projectRoot);
        if (active.lifecycleEpoch !== this.lifecycleEpoch) throw new Error("Parent lifecycle changed while checkpointing the writer.");
        this.closedWriters.set(runId, {
          record: active.record, binding: { ...active.request.runContext.writerBinding },
          sourcePromptDigest: digestAgentRunText(active.request.systemPrompt), transcript,
          transcriptDigest: digestAgentRunText(transcript.toString("utf8")), snapshot, depth: active.continuationDepth ?? 0,
          fastMode: Boolean((active.request.agent.fastMode ?? this.defaultFastMode) && supportsFastModeRoute(splitModel(active.routeModel).identity)),
        });
        while (this.closedWriters.size > 32) this.closedWriters.delete(this.closedWriters.keys().next().value!);
        if ((active.continuationDepth ?? 0) < 3) result.continuation = { runId, workspaceSnapshot: snapshot };
      } catch {
        // A valid finished result does not imply its transcript is eligible for reuse.
      }
    }
    const dashboard = active.request.runContext?.dashboard ?? this.dashboard;
    dashboard?.finishJob(runId, status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", {
      output,
      error: result.error,
      exitCode: result.exitCode,
      latestActivity: status,
      question: undefined,
    });
    dashboard?.setControl(runId, undefined);
    active.request.progress?.(`${active.request.agent.title} ${status}`);
    this.active.delete(runId);
    active.resolve(result);
  }
}

let defaultManager: AgentRunManager | undefined;

export function setDefaultAgentRunManager(manager: AgentRunManager): void {
  defaultManager = manager;
}

export function getDefaultAgentRunManager(): AgentRunManager {
  defaultManager ??= new AgentRunManager();
  return defaultManager;
}
