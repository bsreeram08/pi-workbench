import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SPAWN_MODES = ["auto", "never", "ask", "always"] as const;
export type SpawnMode = (typeof SPAWN_MODES)[number];
export const SPAWN_RELOAD_ENTRY = "pi-workbench-spawn-reload";
export const MIN_SPAWN_FANOUT = 1;
export const MAX_SPAWN_FANOUT = 6;
export const DEFAULT_SPAWN_FANOUT = 3;

export interface SpawnPolicy {
  readonly version: 1;
  readonly mode: SpawnMode;
  readonly fanout: number;
}

export interface EffectiveSpawnPolicy extends SpawnPolicy {
  readonly sessionMode?: SpawnMode;
}

interface StoredSpawnReloadState {
  version: 1;
  sessionMode?: SpawnMode;
}

const POLICY_PATH = () => path.join(getAgentDir(), "workbench", "spawn-policy.json");

function isSpawnMode(value: unknown): value is SpawnMode {
  return typeof value === "string" && (SPAWN_MODES as readonly string[]).includes(value);
}

function clampFanout(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_SPAWN_FANOUT;
  return Math.min(MAX_SPAWN_FANOUT, Math.max(MIN_SPAWN_FANOUT, parsed));
}

export function defaultSpawnPolicy(): SpawnPolicy {
  return { version: 1, mode: "auto", fanout: DEFAULT_SPAWN_FANOUT };
}

export function parseSpawnPolicy(value: unknown): SpawnPolicy {
  const fallback = defaultSpawnPolicy();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const item = value as Record<string, unknown>;
  return {
    version: 1,
    mode: isSpawnMode(item.mode) ? item.mode : fallback.mode,
    fanout: clampFanout(item.fanout),
  };
}

export function effectiveSpawnMode(policy: EffectiveSpawnPolicy): SpawnMode {
  return policy.sessionMode ?? policy.mode;
}

export function spawnPolicyGuidance(policy: EffectiveSpawnPolicy): string | undefined {
  const mode = effectiveSpawnMode(policy);
  const source = policy.sessionMode ? "this session" : "durable default";
  if (mode === "auto") return undefined;
  if (mode === "never") {
    return `## Spawn policy: never (${source})

The user forbade opportunistic specialists. Do not call delegate_task or workbench_agent_start. Keep the work in Main Pi. The user can still run /delegate or change policy with /spawn always|ask|this always.`;
  }
  if (mode === "ask") {
    return `## Spawn policy: ask, fanout ${policy.fanout} (${source})

Do not spawn specialists until the user confirms. Prefer workbench_ask or the native confirm gate. Keep simple work in Main Pi. If confirmed, spawn at most ${policy.fanout} read-only lanes and synthesize here.`;
  }
  return `## Spawn policy: always, fanout ${policy.fanout} (${source})

The user required specialists for this work. Do not keep orientation, research, comparison, or multi-file inspection in Main Pi when a specialist can isolate it.

On get-up-to-speed, audit, compare, or inspect-the-repo tasks:
- spawn up to ${policy.fanout} read-only specialists in one parallel delegate_task
- keep synthesis, decisions, and the user-facing summary in Main Pi
- pass an earlier specialist result with fromRuns and its host-issued runId; do not restate the dump
- do not spawn writers unless the user asked to implement

A single cheap file edit still stays here.`;
}

export function formatSpawnPolicy(policy: EffectiveSpawnPolicy): string {
  const mode = effectiveSpawnMode(policy);
  const session = policy.sessionMode ? ` Session override: **${policy.sessionMode}**.` : "";
  if (mode === "auto") {
    return `Spawn policy is **auto** (fanout ${policy.fanout}). Main Pi decides; simple work stays here.${session} Set a durable default with \`/spawn always|ask|never\`, a cap with \`/spawn fanout <1-6>\`, or this task with \`/spawn this always|ask|never\`.`;
  }
  if (mode === "never") {
    return `Spawn policy is **never**. Main Pi must not call \`delegate_task\` or \`workbench_agent_start\`. You can still \`/delegate\` explicitly.${session}`;
  }
  if (mode === "ask") {
    return `Spawn policy is **ask** (fanout ${policy.fanout}). Main Pi must confirm before spawning specialists.${session}`;
  }
  return `Spawn policy is **always** (fanout ${policy.fanout}). Main Pi should spawn specialists for orientation, research, and multi-file inspection, then synthesize.${session}`;
}

export async function loadSpawnPolicy(): Promise<SpawnPolicy> {
  try {
    return parseSpawnPolicy(JSON.parse(await fs.readFile(POLICY_PATH(), "utf8")));
  } catch {
    return defaultSpawnPolicy();
  }
}

export async function saveSpawnPolicy(policy: SpawnPolicy): Promise<SpawnPolicy> {
  const normalized = parseSpawnPolicy(policy);
  const file = POLICY_PATH();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
  return normalized;
}

let sessionMode: SpawnMode | undefined;

export function getSessionSpawnMode(): SpawnMode | undefined {
  return sessionMode;
}

export function setSessionSpawnMode(mode: SpawnMode | undefined): void {
  sessionMode = mode;
}

export async function getEffectiveSpawnPolicy(): Promise<EffectiveSpawnPolicy> {
  const durable = await loadSpawnPolicy();
  return sessionMode ? { ...durable, sessionMode } : durable;
}

export async function authorizeSpawnTool(
  ctx: { hasUI: boolean; ui?: { confirm(title: string, message: string): Promise<boolean> } },
  laneCount: number,
): Promise<void> {
  const policy = await getEffectiveSpawnPolicy();
  const mode = effectiveSpawnMode(policy);
  if (mode === "never") {
    throw new Error("Spawn policy is never. Keep this work in Main Pi, or the user can /delegate or /spawn always|ask|this always.");
  }
  if (!Number.isInteger(laneCount) || laneCount < 1) throw new Error("Spawn requires at least one specialist lane.");
  if (laneCount > policy.fanout) {
    throw new Error(`Spawn policy fanout is ${policy.fanout}; this call asked for ${laneCount}. Reduce the batch or /spawn fanout ${laneCount}.`);
  }
  if (mode !== "ask") return;
  if (!ctx.hasUI || !ctx.ui) throw new Error("Spawn policy is ask; interactive confirmation is required.");
  const confirmed = await ctx.ui.confirm(
    `Spawn ${laneCount} specialist${laneCount === 1 ? "" : "s"}?`,
    `Policy fanout is ${policy.fanout}. Confirm to launch, or cancel to keep the work in Main Pi.`,
  );
  if (!confirmed) throw new Error("Spawn was not confirmed.");
}

function parseCommand(rawArgs: string): { action: string; value?: string } {
  const parts = rawArgs.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "status") return { action: "status" };
  if (parts[0] === "this" && isSpawnMode(parts[1]) && !parts[2]) return { action: "this", value: parts[1] };
  if (parts[0] === "fanout" && parts[1] && !parts[2]) return { action: "fanout", value: parts[1] };
  if (isSpawnMode(parts[0]) && !parts[1]) return { action: "mode", value: parts[0] };
  return { action: "usage" };
}

export function registerSpawnPolicy(
  pi: ExtensionAPI,
  report?: (title: string, body: string) => void,
): void {
  const updateStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const policy = await getEffectiveSpawnPolicy();
    const mode = effectiveSpawnMode(policy);
    ctx.ui.setStatus("spawn", mode === "auto" ? undefined : `spawn:${mode}/${policy.fanout}`);
  };

  const show = async (ctx: ExtensionContext): Promise<void> => {
    const body = formatSpawnPolicy(await getEffectiveSpawnPolicy());
    if (report) report("Spawn policy", body);
    else if (ctx.hasUI) ctx.ui.notify(body, "info");
  };

  pi.registerCommand("spawn", {
    description: "Control specialist spawning: /spawn [always|ask|never|auto|fanout N|this always|ask|never|status]",
    handler: async (rawArgs, ctx) => {
      const parsed = parseCommand(rawArgs);
      if (parsed.action === "usage") {
        const usage = "Usage: /spawn [always|ask|never|auto|status]\n       /spawn fanout <1-6>\n       /spawn this always|ask|never|auto";
        if (report) report("Spawn policy", usage);
        else if (ctx.hasUI) ctx.ui.notify(usage, "warning");
        return;
      }
      if (parsed.action === "status") {
        await show(ctx);
        await updateStatus(ctx);
        return;
      }
      if (!ctx.isIdle()) {
        const body = "Spawn policy can change only while Pi is idle. Stop or wait for the current work to settle, then retry.";
        if (report) report("Spawn policy unchanged", body);
        else if (ctx.hasUI) ctx.ui.notify(body, "warning");
        return;
      }
      if (parsed.action === "this") {
        setSessionSpawnMode(parsed.value === "auto" ? undefined : parsed.value as SpawnMode);
        await updateStatus(ctx);
        await show(ctx);
        return;
      }
      const current = await loadSpawnPolicy();
      if (parsed.action === "fanout") {
        const fanout = Number(parsed.value);
        if (!Number.isInteger(fanout) || fanout < MIN_SPAWN_FANOUT || fanout > MAX_SPAWN_FANOUT) {
          const body = `Fanout must be an integer from ${MIN_SPAWN_FANOUT} to ${MAX_SPAWN_FANOUT}.`;
          if (report) report("Spawn policy unchanged", body);
          else if (ctx.hasUI) ctx.ui.notify(body, "warning");
          return;
        }
        await saveSpawnPolicy({ ...current, fanout });
        await updateStatus(ctx);
        await show(ctx);
        return;
      }
      await saveSpawnPolicy({ ...current, mode: parsed.value as SpawnMode });
      await updateStatus(ctx);
      await show(ctx);
    },
  });

  pi.on("before_agent_start", async (event) => {
    const policy = await getEffectiveSpawnPolicy();
    const guidance = spawnPolicyGuidance(policy);
    if (!guidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload") {
      pi.appendEntry<StoredSpawnReloadState>(SPAWN_RELOAD_ENTRY, { version: 1, sessionMode });
    }
  });

  pi.on("session_start", async (event, ctx) => {
    sessionMode = undefined;
    if (event.reason === "reload") {
      const entry = ctx.sessionManager.getBranch()
        .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === SPAWN_RELOAD_ENTRY)
        .pop() as { data?: Partial<StoredSpawnReloadState> } | undefined;
      if (entry?.data?.version === 1 && isSpawnMode(entry.data.sessionMode)) sessionMode = entry.data.sessionMode;
    }
    await updateStatus(ctx);
  });
}
