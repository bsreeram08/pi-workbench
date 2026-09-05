import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseDelegationModel } from "./routing.ts";
import { ensureWorkflowState, type WorkflowPaths } from "./workflow-state.ts";

export const TASK_MODEL_ACTIONS = ["plan-review", "implement", "repair", "review"] as const;
export type TaskModelAction = typeof TASK_MODEL_ACTIONS[number];
export interface TaskModelBinding { id: string; task: string }
export interface TaskModelPreference {
  domain: string;
  actions: TaskModelAction[];
  model: string;
  reason: string;
}
export interface TaskModelPolicy {
  version: 1;
  planId: string;
  taskDigest: string;
  preferences: TaskModelPreference[];
}
const MAX_BYTES = 32_768;
const MAX_PREFERENCES = 32;
const digest = (task: string) => createHash("sha256").update(task).digest("hex");
const policyPath = (paths: WorkflowPaths) => path.join(paths.root, "task-model-policy.json");
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function preference(value: unknown): TaskModelPreference {
  if (!plain(value) || !exactKeys(value, ["domain", "actions", "model", "reason"])
    || typeof value.domain !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.domain)
    || typeof value.model !== "string" || value.model.length > 256
    || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2_000
    || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > TASK_MODEL_ACTIONS.length
    || new Set(value.actions).size !== value.actions.length
    || !value.actions.every((action) => TASK_MODEL_ACTIONS.includes(action as TaskModelAction))) {
    throw new Error("Invalid task model preference: provide a domain, distinct action scopes, exact model, and user direction.");
  }
  return { domain: value.domain, actions: value.actions as TaskModelAction[], model: parseDelegationModel(value.model).model, reason: value.reason.trim() };
}

function decode(content: string): TaskModelPolicy {
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("Task model policy is malformed; no adaptive fallback was selected."); }
  if (!plain(value) || !exactKeys(value, ["version", "planId", "taskDigest", "preferences"])
    || value.version !== 1 || typeof value.planId !== "string" || !value.planId || value.planId.length > 256
    || typeof value.taskDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.taskDigest)
    || !Array.isArray(value.preferences) || value.preferences.length > MAX_PREFERENCES) {
    throw new Error("Task model policy is invalid; no adaptive fallback was selected.");
  }
  const preferences = value.preferences.map(preference);
  const scopes = new Set<string>();
  for (const item of preferences) for (const action of item.actions) {
    const scope = `${item.domain}:${action}`;
    if (scopes.has(scope)) throw new Error("Task model policy contains overlapping scopes.");
    scopes.add(scope);
  }
  return { version: 1, planId: value.planId, taskDigest: value.taskDigest, preferences };
}

/** Read on every action, including after reload. Unsafe or malformed files never become an adaptive route. */
export async function readTaskModelPolicy(paths: WorkflowPaths, binding: TaskModelBinding): Promise<TaskModelPolicy | null> {
  for (const directory of [path.dirname(path.dirname(paths.root)), path.dirname(paths.root), paths.root]) {
    const stat = await fs.lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Task model policy directory is unsafe.");
  }
  const handle = await fs.open(policyPath(paths), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Task model policy cannot be safely opened; no adaptive fallback was selected.");
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1) throw new Error("Task model policy is not a bounded regular file.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, size);
      if (chunk.bytesRead === 0) break;
      size += chunk.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Task model policy exceeds its size limit.");
    const policy = decode(bytes.subarray(0, size).toString("utf8"));
    return policy.planId === binding.id && policy.taskDigest === digest(binding.task) ? policy : null;
  } finally { await handle.close(); }
}

/** Caller holds the project writer lease and has checked the current plan binding and user direction. */
export async function setTaskModelPreference(
  paths: WorkflowPaths,
  binding: TaskModelBinding,
  input: TaskModelPreference & { replace?: boolean },
): Promise<TaskModelPolicy> {
  const next = preference({ domain: input.domain, actions: input.actions, model: input.model, reason: input.reason });
  if (!binding.id || binding.id.length > 256 || !binding.task.trim()) throw new Error("Task model policy requires the current task identity.");
  const current = await readTaskModelPolicy(paths, binding);
  const preferences: TaskModelPreference[] = [];
  for (const item of current?.preferences ?? []) {
    const overlaps = item.domain === next.domain && item.actions.some((action) => next.actions.includes(action));
    if (overlaps && item.model !== next.model && input.replace !== true) {
      throw new Error(`Task model preference conflicts with ${item.model}. Explicit replacement is required to change the user's model choice.`);
    }
    const actions = overlaps ? item.actions.filter((action) => !next.actions.includes(action)) : item.actions;
    if (actions.length) preferences.push({ ...item, actions });
  }
  preferences.push(next);
  const policy: TaskModelPolicy = { version: 1, planId: binding.id, taskDigest: digest(binding.task), preferences };
  const content = `${JSON.stringify(policy, null, 2)}\n`;
  if (preferences.length > MAX_PREFERENCES || Buffer.byteLength(content) > MAX_BYTES) throw new Error("Task model policy exceeds its size limit.");
  await ensureWorkflowState(paths);
  // Revalidate the destination immediately before writing; leases serialize cooperating writers.
  await readTaskModelPolicy(paths, binding);
  const temporary = path.join(paths.root, `.task-model-policy.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, policyPath(paths));
  } finally { await fs.unlink(temporary).catch(() => undefined); }
  return policy;
}

/** Domain classification is Main Pi's decision; the host enforces its recorded scope, not semantic inference. */
export function resolveTaskModel(
  policy: TaskModelPolicy | null,
  request: { domain?: string; action: TaskModelAction; model?: string },
): string | undefined {
  const applicable = policy?.preferences.filter((item) => item.actions.includes(request.action)) ?? [];
  if (!request.domain && applicable.length) throw new Error("This task has scoped model preferences. Provide the work domain before choosing a model.");
  const pin = applicable.find((item) => item.domain === request.domain);
  const requested = request.model === undefined ? undefined : parseDelegationModel(request.model).model;
  if (pin && requested !== undefined && requested !== pin.model) {
    throw new Error(`The ${request.domain} ${request.action} model is pinned to ${pin.model}. Explicitly replace the stored preference before selecting ${requested}. No substitute was selected.`);
  }
  return pin?.model ?? requested;
}
