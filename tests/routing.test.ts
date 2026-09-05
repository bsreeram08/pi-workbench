import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig } from "../config.ts";
import {
  MODEL_ROUTING_ENTRY,
  MODEL_ROUTING_RECEIPT_ENTRY,
  parseModelRoutingCommand,
  parseRoutingMenuFamily,
  parseRoutingMenuPolicy,
  parseRoutingMenuScope,
  readDurableRouting,
  registerModelRouting,
  restoreModelRoutingState,
  writeDurableRouting,
} from "../model-routing.ts";
import {
  BALANCED_ROUTES,
  GROK_BALANCED_ROUTES,
  GROK_PRIMARY_ROUTE,
  READ_ONLY_BUDGETS,
  classifyRoutingEffort,
  formatRoutingReceipt,
  nativeSubagentFallback,
  parseFixedRoutingModel,
  parseSessionRoutingDirective,
  routeTask,
} from "../routing.ts";

describe("adaptive model routing", () => {
  test("an exact delegation model wins over session routing without changing the effort budget", () => {
    const route = routeTask({ task: "Review the UI design", model: "openai-codex/gpt-6-astra:high", effort: "light", readOnly: true,
      policy: { policy: "fixed", fixed: BALANCED_ROUTES.standard } });
    expect(route.model).toBe("openai-codex/gpt-6-astra:high");
    expect(route.budget).toEqual(READ_ONLY_BUDGETS.light);
    expect(route.reason).toContain("explicit per-delegation");
    expect(() => routeTask({ task: "Review UI", model: "astra" })).toThrow("exact provider/model");
    expect(() => routeTask({ task: "Review UI", model: "openai-codex/gpt-5.3-codex-spark" })).toThrow("No substitution");
  });
  test("promotes a hard scout lane to Sol while keeping a bounded scout lane light", () => {
    const light = routeTask({ task: "Find the definition of loadConfig.", role: "scout", readOnly: true });
    const heavy = routeTask({
      task: "Investigate a hard cross-cutting concurrency bug, establish the root cause across services, and independently verify it.",
      role: "scout",
      readOnly: true,
    });

    expect(light.effort).toBe("light");
    expect(light.model).toBe("openai-codex/gpt-5.6-luna:low");
    expect(routeTask({ task: "Review a bounded API change and run its tests.", effort: "standard" }).model)
      .toBe("openai-codex/gpt-5.6-terra:medium");
    expect(heavy.effort).toBe("heavy");
    expect(heavy.model).toBe("openai-codex/gpt-5.6-sol:high");
    expect(heavy.budget).toEqual(READ_ONLY_BUDGETS.heavy);
    expect(formatRoutingReceipt("scout", heavy)).toContain("scout → openai-codex/gpt-5.6-sol · high");
    expect(formatRoutingReceipt("scout", heavy)).toContain("30 turns/120 tools");
  });

  test("uses explicit parent effort instead of treating role as destiny", () => {
    expect(routeTask({ task: "Inspect this one symbol.", role: "technical-reviewer", effort: "light" }).model)
      .toBe(BALANCED_ROUTES.light.model);
    expect(routeTask({ task: "Inspect this one symbol.", role: "scout", effort: "heavy" }).model)
      .toBe(BALANCED_ROUTES.heavy.model);
  });

  test("routes balanced, economy, quality, and fixed policies", () => {
    const request = { task: "Review the bounded change and run tests.", effort: "standard" as const };
    expect(routeTask({ ...request, policy: { policy: "balanced" } }).model).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(routeTask({ ...request, policy: { policy: "economy" } }).model).toBe("openai-codex/gpt-5.3-codex-spark:medium");
    expect(routeTask({ ...request, policy: { policy: "quality" } }).model).toBe("openai-codex/gpt-5.6-sol:high");
    expect(routeTask({
      ...request,
      policy: { policy: "fixed", fixed: { model: "openai-codex/custom-model:high", thinking: "high" } },
    }).model).toBe("openai-codex/custom-model:high");
  });

  test("assigns approved read-only budgets and avoids Spark for common visual work", () => {
    expect(routeTask({ task: "Find one symbol.", effort: "light", readOnly: true }).budget).toEqual({ turns: 8, tools: 30 });
    for (const task of [
      "Review a screenshot for defects.",
      "Inspect the SVG icon.",
      "Check the Figma screen layout.",
      "Review frontend rendering.",
      "Assess the UI animation.",
      "Inspect the video frame.",
    ]) {
      expect(routeTask({ task, effort: "light", readOnly: true }).model).toBe("openai-codex/gpt-5.6-luna:low");
    }
    expect(routeTask({ task: "Implement a bounded fix.", effort: "light", readOnly: false }).budget).toBeUndefined();
  });

  test("accepts Codex and xAI Grok fixed routes and enforces a thinking suffix", () => {
    expect(parseFixedRoutingModel("sol")).toEqual(BALANCED_ROUTES.heavy);
    expect(parseFixedRoutingModel("grok")).toEqual(GROK_PRIMARY_ROUTE);
    expect(parseFixedRoutingModel("openai-codex/custom-model")).toEqual({
      model: "openai-codex/custom-model:medium",
      thinking: "medium",
    });
    expect(parseFixedRoutingModel("openai-codex/custom-model:high")).toEqual({
      model: "openai-codex/custom-model:high",
      thinking: "high",
    });
    expect(parseFixedRoutingModel("xai/grok-4.6")).toEqual({
      model: "xai/grok-4.6:medium",
      thinking: "medium",
    });
    expect(parseFixedRoutingModel("xai/grok-4.6:high")).toEqual(GROK_PRIMARY_ROUTE);
    expect(parseFixedRoutingModel("provider/custom-model:high")).toBeUndefined();
    expect(parseFixedRoutingModel("openai-codex/bad model")).toBeUndefined();
  });

  test("routes the Grok 4.6 family by thinking level without changing Codex defaults", () => {
    const request = { task: "Review the bounded change and run tests.", effort: "standard" as const };
    expect(routeTask(request).model).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(routeTask({ ...request, policy: { policy: "balanced", family: "grok" } }).model).toBe(GROK_BALANCED_ROUTES.standard.model);
    expect(routeTask({ task: "Find one symbol.", effort: "light", policy: { policy: "balanced", family: "grok" } }).model)
      .toBe(GROK_BALANCED_ROUTES.light.model);
    expect(routeTask({
      task: "Investigate a hard cross-cutting concurrency root cause across services.",
      effort: "heavy",
      policy: { policy: "quality", family: "grok" },
    }).model).toBe(GROK_BALANCED_ROUTES.heavy.model);
  });

  test("uses a deterministic conservative auto classifier", () => {
    expect(classifyRoutingEffort("Rename one local constant.", "worker").effort).toBe("light");
    expect(classifyRoutingEffort("Implement an API change and verify compatibility.", "worker").effort).toBe("standard");
    expect(classifyRoutingEffort("Plan a security migration across services.", "scout").effort).toBe("heavy");
  });
});

describe("session routing controls", () => {
  test("parses exact natural-language session directives", () => {
    expect(parseSessionRoutingDirective("use sol for everything this session")).toEqual({
      kind: "fixed",
      fixed: BALANCED_ROUTES.heavy,
    });
    expect(parseSessionRoutingDirective("please use sol for everything")).toEqual({
      kind: "fixed",
      fixed: BALANCED_ROUTES.heavy,
    });
    expect(parseSessionRoutingDirective("use luna for everything")).toEqual({
      kind: "fixed",
      fixed: { model: "openai-codex/gpt-5.6-luna:low", thinking: "low" },
    });
    expect(parseSessionRoutingDirective("Use economy routing this session.")).toEqual({ kind: "policy", policy: "economy" });
    expect(parseSessionRoutingDirective("use grok for everything this session")).toEqual({
      kind: "fixed",
      fixed: GROK_PRIMARY_ROUTE,
    });
    expect(parseSessionRoutingDirective("use grok routing this session")).toEqual({ kind: "family", family: "grok" });
    expect(parseSessionRoutingDirective("use codex routing this session")).toEqual({ kind: "family", family: "codex" });
    expect(parseSessionRoutingDirective("use sol for everything and inspect this file")).toBeUndefined();
  });

  test("restores only valid session custom-entry data and otherwise returns balanced", () => {
    const entry = {
      customType: MODEL_ROUTING_ENTRY,
      data: { version: 1, state: { policy: "fixed", fixed: { model: "openai-codex/gpt-5.6-sol:high", thinking: "high" } } },
    };
    expect(restoreModelRoutingState(entry.data)).toEqual(entry.data.state);
    expect(restoreModelRoutingState({
      version: 1,
      state: { policy: "balanced", family: "grok" },
    })).toEqual({ policy: "balanced", family: "grok" });
    expect(restoreModelRoutingState({
      version: 1,
      state: { policy: "fixed", fixed: { model: "xai/grok-4.6:high", thinking: "high" } },
    })).toEqual({ policy: "fixed", fixed: GROK_PRIMARY_ROUTE });
    expect(restoreModelRoutingState({ version: 1, state: { policy: "fixed", fixed: { model: "provider/custom:high", thinking: "high" } } })).toEqual({ policy: "balanced" });
    expect(restoreModelRoutingState({ version: 1, state: { policy: "fixed", fixed: { model: "openai-codex/custom", thinking: "medium" } } })).toEqual({ policy: "balanced" });
    expect(restoreModelRoutingState({ version: 2, state: { policy: "quality" } })).toEqual({ policy: "balanced" });
  });

  test("persists command and natural-language overrides without calling parent model setters", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    let parentModelSets = 0;
    let parentThinkingSets = 0;
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
      registerEntryRenderer() {},
      setModel: async () => { parentModelSets++; return true; },
      setThinkingLevel: () => { parentThinkingSets++; },
    } as any;
    registerModelRouting(pi);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { setStatus() {}, notify() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        find(provider: string, model: string) {
          if (provider === "xai" && model === "grok-4.6") return { provider, id: model };
          return provider === "openai-codex" && [
            "gpt-5.3-codex-spark",
            "gpt-5.6-luna",
            "gpt-5.6-terra",
            "gpt-5.6-sol",
          ].includes(model) ? { provider, id: model } : undefined;
        },
      },
    };

    await handlers.get("session_start")?.[0]?.({}, ctx);
    await commands.get("model-routing")?.("fixed sol", ctx);
    await handlers.get("input")?.[0]?.({ text: "use terra for everything this session" }, ctx);
    await commands.get("model-routing")?.("grok", ctx);
    await commands.get("model-routing")?.("fixed grok", ctx);
    await commands.get("model-routing")?.("fixed provider/not-allowed:high", ctx);
    await commands.get("model-routing")?.("fixed openai-codex/not-installed:high", ctx);
    await commands.get("model-routing")?.("fixed xai/not-installed:high", ctx);

    expect(entries.filter((entry) => entry.customType === MODEL_ROUTING_ENTRY)).toHaveLength(4);
    expect(entries.filter((entry) => entry.customType === MODEL_ROUTING_RECEIPT_ENTRY)).toHaveLength(1);
    expect(parentModelSets).toBe(0);
    expect(parentThinkingSets).toBe(0);

    const input: Record<string, unknown> = { agent: "scout", task: "Inspect the API." };
    handlers.get("tool_call")?.[0]?.({ toolName: "subagent", input }, ctx);
    expect(input.model).toBeUndefined();
    expect(entries.filter((entry) => entry.customType === MODEL_ROUTING_RECEIPT_ENTRY).at(-1)).toMatchObject({
      data: { content: expect.stringContaining("delegate_task") },
    });
  });
});

describe("native pi-subagents fallback", () => {
  test("classifies direct single-agent tasks and applies bounded read-only defaults", () => {
    const standard = nativeSubagentFallback({ agent: "scout", task: "Inspect the API." });
    expect(standard.input.model).toBe("openai-codex/gpt-5.6-terra:medium");
    expect(standard.input.thinking).toBe("medium");
    expect(standard.input.turnBudget).toEqual({ maxTurns: 16, graceTurns: 1 });
    expect(standard.input.toolBudget).toEqual({ soft: 55, hard: 60 });

    const heavy = nativeSubagentFallback({
      agent: "scout",
      task: "Investigate a hard cross-cutting concurrency root cause across services and independently verify it.",
    });
    expect(heavy.input.model).toBe("openai-codex/gpt-5.6-sol:high");
    expect(heavy.input.turnBudget).toEqual({ maxTurns: 30, graceTurns: 1 });
  });

  test("does not override explicit model/thinking or parse and rewrite workflowScript", () => {
    const workflowScript = `return runs.run("scan", { agent: "scout", task: "hard investigation", model: "provider/explicit:high" })`;
    const fallback = nativeSubagentFallback({
      workflowScript,
      model: "provider/workflow-default:low",
      thinking: "high",
      turnBudget: { maxTurns: 9 },
    });
    expect(fallback.input.model).toBe("provider/workflow-default:low");
    expect(fallback.input.thinking).toBe("high");
    expect(fallback.input.workflowScript).toBe(workflowScript);
    expect(fallback.input.turnBudget).toEqual({ maxTurns: 9 });

    const explicitModel = nativeSubagentFallback({ agent: "scout", model: "provider/explicit:high" });
    expect(explicitModel.input.model).toBe("provider/explicit:high");
    expect(explicitModel.input.thinking).toBe("high");
    expect(explicitModel.route.model).toBe("provider/explicit:high");

    const explicitThinking = nativeSubagentFallback({ agent: "scout", thinking: "high" });
    expect(explicitThinking.input.thinking).toBe("high");
    expect(explicitThinking.input.model).toBe("openai-codex/gpt-5.6-terra:high");

    const explicitBudgets = nativeSubagentFallback({
      agent: "scout",
      task: "Inspect the API.",
      turnBudget: { maxTurns: 9, graceTurns: 2 },
      toolBudget: { soft: 10, hard: 12 },
    });
    expect(explicitBudgets.route.effectiveLimits).toEqual({ turns: 9, tools: 12 });
    expect(formatRoutingReceipt("scout", explicitBudgets.route)).toContain("9 turns/12 tools");
  });

  test("sets a fixed session model as the opaque workflow default", () => {
    const fallback = nativeSubagentFallback(
      { workflowScript: `return runs.run("scan", { agent: "scout", task: "inspect" })` },
      { policy: "fixed", fixed: BALANCED_ROUTES.heavy },
    );
    expect(fallback.input.model).toBe(BALANCED_ROUTES.heavy.model);
    expect(fallback.input.thinking).toBe("high");
  });
});

describe("legacy routing config normalization", () => {
  test("preserves legacy model fields while adding the balanced durable policy", () => {
    const config = normalizeConfig({
      workflowFastModel: "legacy/fast:low",
      workflowPlanningModel: "legacy/plan:high",
    });
    expect(config.workflowFastModel).toBe("legacy/fast:low");
    expect(config.workflowPlanningModel).toBe("legacy/plan:high");
    expect(config.modelRoutingPolicy).toBe("balanced");
    expect(config.modelRoutingFamily).toBe("codex");
    expect(normalizeConfig({ modelRoutingPolicy: "quality" }).modelRoutingPolicy).toBe("quality");
    expect(normalizeConfig({ modelRoutingPolicy: "fixed" }).modelRoutingPolicy).toBe("balanced");
    expect(normalizeConfig({ modelRoutingFamily: "grok" }).modelRoutingFamily).toBe("grok");
  });
});

describe("durable family defaults and customize menu", () => {
  test("parses menu, --default, and rejects durable fixed routes", () => {
    expect(parseModelRoutingCommand("")).toEqual({ kind: "open" });
    expect(parseModelRoutingCommand("status")).toEqual({ kind: "status" });
    expect(parseModelRoutingCommand("menu")).toEqual({ kind: "menu" });
    expect(parseModelRoutingCommand("grok --default")).toEqual({ kind: "family", family: "grok", makeDefault: true });
    expect(parseModelRoutingCommand("--default grok")).toEqual({ kind: "family", family: "grok", makeDefault: true });
    expect(parseModelRoutingCommand("codex --default")).toEqual({ kind: "family", family: "codex", makeDefault: true });
    expect(parseModelRoutingCommand("quality --default")).toEqual({ kind: "policy", policy: "quality", makeDefault: true });
    expect(parseModelRoutingCommand("fixed grok --default").kind).toBe("usage");
    expect(parseRoutingMenuFamily("Grok 4.6 (low/medium/high)")).toBe("grok");
    expect(parseRoutingMenuPolicy("Balanced")).toBe("balanced");
    expect(parseRoutingMenuScope("Save as project default")).toBe(true);
    expect(parseRoutingMenuScope("This session only")).toBe(false);
  });

  test("writes only --default family changes into project config", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workbench-routing-"));
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      appendEntry() {},
      registerEntryRenderer() {},
    } as any;
    registerModelRouting(pi);
    const ctx = {
      cwd: root,
      hasUI: false,
      ui: { setStatus() {}, notify() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: () => undefined },
    };
    try {
      await handlers.get("session_start")?.[0]?.({}, ctx);
      await commands.get("model-routing")?.("grok", ctx);
      expect(readDurableRouting(root)).toEqual({ policy: "balanced", family: "codex" });
      await commands.get("model-routing")?.("grok --default", ctx);
      expect(readDurableRouting(root)).toEqual({ policy: "balanced", family: "grok" });
      const written = JSON.parse(readFileSync(join(root, ".pi", "pi-workbench", "config.json"), "utf8"));
      expect(written).toMatchObject({ modelRoutingFamily: "grok", modelRoutingPolicy: "balanced" });
      await commands.get("model-routing")?.("codex --default", ctx);
      expect(readDurableRouting(root).family).toBe("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes --default config at the git project root from a nested cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workbench-routing-git-"));
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const git = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    expect(git.status).toBe(0);
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      on() {},
      appendEntry() {},
      registerEntryRenderer() {},
    } as any;
    registerModelRouting(pi);
    const ctx = {
      cwd: nested,
      hasUI: false,
      ui: { setStatus() {}, notify() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: () => undefined },
    };
    try {
      await commands.get("model-routing")?.("grok --default", ctx);
      expect(readDurableRouting(nested)).toEqual({ policy: "balanced", family: "grok" });
      expect(readFileSync(join(root, ".pi", "pi-workbench", "config.json"), "utf8")).toContain('"modelRoutingFamily": "grok"');
      expect(existsSync(join(nested, ".pi"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("natural-language routing keeps the other axis of the current session state", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      appendEntry() {},
      registerEntryRenderer() {},
    } as any;
    const controller = registerModelRouting(pi);
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      ui: { setStatus() {}, notify() {} },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: () => undefined },
    };
    await handlers.get("session_start")?.[0]?.({}, ctx);
    await commands.get("model-routing")?.("quality", ctx);
    await handlers.get("input")?.[0]?.({ text: "use grok routing this session" }, ctx);
    expect(controller.getState()).toEqual({ policy: "quality", family: "grok" });
    await handlers.get("input")?.[0]?.({ text: "use economy routing this session" }, ctx);
    expect(controller.getState()).toEqual({ policy: "economy", family: "grok" });
    await handlers.get("input")?.[0]?.({ text: "use codex routing this session" }, ctx);
    expect(controller.getState()).toEqual({ policy: "economy" });
  });

  test("interactive menu can save Grok 4.6 as the project default", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workbench-routing-menu-"));
    const answers = [
      "Grok 4.6 (low/medium/high)",
      "Balanced",
      "Save as project default",
    ];
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command.handler);
      },
      on() {},
      appendEntry() {},
      registerEntryRenderer() {},
    } as any;
    registerModelRouting(pi);
    const ctx = {
      cwd: root,
      hasUI: true,
      ui: {
        setStatus() {},
        notify() {},
        select: async () => answers.shift(),
      },
      sessionManager: { getBranch: () => [] },
      modelRegistry: { find: () => undefined },
    };
    try {
      await commands.get("model-routing")?.("", ctx);
      expect(readDurableRouting(root)).toEqual({ policy: "balanced", family: "grok" });
      expect(writeDurableRouting(root, { family: "codex" })).toContain("config.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
