import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  authorizeSpawnTool,
  DEFAULT_SPAWN_FANOUT,
  formatSpawnPolicy,
  getEffectiveSpawnPolicy,
  loadSpawnPolicy,
  parseSpawnPolicy,
  registerSpawnPolicy,
  saveSpawnPolicy,
  setSessionSpawnMode,
  spawnPolicyGuidance,
  SPAWN_RELOAD_ENTRY,
} from "../spawn-policy.ts";

afterEach(() => {
  setSessionSpawnMode(undefined);
});

describe("spawn policy parsing", () => {
  test("defaults to auto with fanout 3 and clamps invalid fanout", () => {
    expect(parseSpawnPolicy(undefined)).toEqual({ version: 1, mode: "auto", fanout: DEFAULT_SPAWN_FANOUT });
    expect(parseSpawnPolicy({ version: 1, mode: "always", fanout: 9 }).fanout).toBe(6);
    expect(parseSpawnPolicy({ version: 1, mode: "nope", fanout: 0 }).mode).toBe("auto");
  });

  test("auto injects no guidance; always requires specialists for orientation", () => {
    expect(spawnPolicyGuidance({ version: 1, mode: "auto", fanout: 3 })).toBeUndefined();
    const always = spawnPolicyGuidance({ version: 1, mode: "always", fanout: 4 });
    expect(always).toContain("Spawn policy: always, fanout 4");
    expect(always).toContain("get-up-to-speed");
    expect(always).toContain("do not spawn writers unless the user asked to implement");
    expect(spawnPolicyGuidance({ version: 1, mode: "never", fanout: 3 })).toContain("Do not call delegate_task");
    expect(formatSpawnPolicy({ version: 1, mode: "ask", fanout: 2, sessionMode: "always" })).toContain("Session override: **always**");
  });
});

async function withTempAgentDir<T>(work: () => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-spawn-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("spawn tool authorization", () => {
  test("never blocks opportunistic tools; auto and always allow within fanout", async () => {
    await withTempAgentDir(async () => {
      setSessionSpawnMode("never");
      await expect(authorizeSpawnTool({ hasUI: false }, 1)).rejects.toThrow("Spawn policy is never");
      setSessionSpawnMode("always");
      await authorizeSpawnTool({ hasUI: false }, 1);
      await expect(authorizeSpawnTool({ hasUI: false }, 8)).rejects.toThrow("fanout is 3");
    });
  });

  test("ask requires interactive confirmation", async () => {
    await withTempAgentDir(async () => {
    setSessionSpawnMode("ask");
    await expect(authorizeSpawnTool({ hasUI: false }, 1)).rejects.toThrow("interactive confirmation");
    let asked = "";
    await authorizeSpawnTool({
      hasUI: true,
      ui: {
        async confirm(title) {
          asked = title;
          return true;
        },
      },
    }, 2);
    expect(asked).toBe("Spawn 2 specialists?");
    await expect(authorizeSpawnTool({
      hasUI: true,
      ui: { async confirm() { return false; } },
    }, 1)).rejects.toThrow("not confirmed");
    });
  });
});

describe("spawn command", () => {
  test("is auto by default and injects guidance only when not auto", async () => {
    const harness = createHarness();
    await harness.handlers.get("session_start")?.[0]?.({ reason: "startup" }, harness.ctx);
    await harness.commands.get("spawn")?.("status", harness.ctx);
    expect(harness.reports.at(-1)?.body).toContain("Spawn policy is **auto**");
    expect(await harness.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, harness.ctx)).toBeUndefined();
  });

  test("durable always injects orientation spawning; this overrides for the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-spawn-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const harness = createHarness();
      await harness.commands.get("spawn")?.("always", harness.ctx);
      expect((await loadSpawnPolicy()).mode).toBe("always");
      const injected = await harness.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, harness.ctx) as { systemPrompt: string };
      expect(injected.systemPrompt).toContain("Spawn policy: always");
      expect(harness.statuses.at(-1)).toBe("spawn:always/3");

      await harness.commands.get("spawn")?.("this never", harness.ctx);
      const never = await harness.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, harness.ctx) as { systemPrompt: string };
      expect(never.systemPrompt).toContain("Spawn policy: never");
      expect((await getEffectiveSpawnPolicy()).mode).toBe("always");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("survives extension reload for the session override only", async () => {
    const original = createHarness();
    await original.commands.get("spawn")?.("this always", original.ctx);
    await original.handlers.get("session_shutdown")?.[0]?.({ reason: "reload" }, original.ctx);
    expect(original.entries).toEqual([{ type: "custom", customType: SPAWN_RELOAD_ENTRY, data: { version: 1, sessionMode: "always" } }]);

    const reloaded = createHarness(original.entries);
    await reloaded.handlers.get("session_start")?.[0]?.({ reason: "reload" }, reloaded.ctx);
    const injected = await reloaded.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, reloaded.ctx) as { systemPrompt: string };
    expect(injected.systemPrompt).toContain("this session");
  });

  test("rejects changes while a run is active and unknown args", async () => {
    const harness = createHarness();
    harness.setIdle(false);
    await harness.commands.get("spawn")?.("always", harness.ctx);
    expect(harness.reports.at(-1)?.title).toBe("Spawn policy unchanged");
    harness.setIdle(true);
    await harness.commands.get("spawn")?.("wat", harness.ctx);
    expect(harness.reports.at(-1)?.body).toContain("Usage:");
  });

  test("persists fanout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-spawn-fanout-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const harness = createHarness();
      await harness.commands.get("spawn")?.("fanout 5", harness.ctx);
      expect((await loadSpawnPolicy()).fanout).toBe(5);
      await harness.commands.get("spawn")?.("fanout 0", harness.ctx);
      expect((await loadSpawnPolicy()).fanout).toBe(5);
      await saveSpawnPolicy({ version: 1, mode: "auto", fanout: 2 });
      expect((await loadSpawnPolicy()).fanout).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

interface SpawnHarness {
  commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
  reports: Array<{ title: string; body: string }>;
  statuses: Array<string | undefined>;
  entries: Array<{ type: "custom"; customType: string; data: unknown }>;
  setIdle(value: boolean): void;
  ctx: any;
}

function createHarness(initialEntries: SpawnHarness["entries"] = []): SpawnHarness {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const reports: Array<{ title: string; body: string }> = [];
  const statuses: Array<string | undefined> = [];
  const entries = initialEntries.map((entry) => ({ ...entry }));
  let idle = true;
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as any;
  const ctx = {
    hasUI: true,
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      notify() {},
    },
  };
  registerSpawnPolicy(pi, (title, body) => reports.push({ title, body }));
  return {
    commands,
    handlers,
    reports,
    statuses,
    entries,
    setIdle(value: boolean) { idle = value; },
    ctx,
  };
}
