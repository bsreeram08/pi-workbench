import { describe, expect, test } from "bun:test";
import { registerAgentRuntimeTools } from "../agent-runtime-tools.ts";
import { getDefaultAgentRunManager, setDefaultAgentRunManager } from "../agent-run-manager.ts";
import { runSingleAgent } from "../subagents.ts";
import { SupervisorClient } from "../supervisor.ts";

describe("first-party agent runtime tool surface", () => {
  test("registers clear functional operations without replacing delegate_task", () => {
    const tools: Array<{ name: string; description?: string }> = [];
    const pi = {
      registerTool(tool: { name: string; description?: string }) { tools.push(tool); },
    };
    registerAgentRuntimeTools(pi as any, {
      manager: {} as any,
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      getRoutingState: () => ({ policy: "balanced" }),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "workbench_agent_start",
      "workbench_agent_message",
      "workbench_agent_status",
      "workbench_agent_answer",
      "workbench_agent_cancel",
      "workbench_agent_focus",
    ]);
    expect(tools.some((tool) => tool.name === "subagent")).toBe(false);
    expect(tools.find((tool) => tool.name === "workbench_agent_start")?.description).toContain("persistent");
    expect(tools.find((tool) => tool.name === "workbench_agent_focus")?.description).toContain("cmux tab");
  });

  test("rejects persistent mutation-capable profiles before project discovery", async () => {
    const tools: any[] = [];
    registerAgentRuntimeTools({ registerTool(tool: unknown) { tools.push(tool); } } as any, {
      manager: {} as any,
      exec: async () => { throw new Error("project discovery must not run"); },
      getRoutingState: () => ({ policy: "balanced" }),
    });
    const start = tools.find((tool) => tool.name === "workbench_agent_start");
    await expect(start.execute("call", { agent: "implementer", task: "Change files." }, undefined, undefined, { cwd: "/missing" }))
      .rejects.toThrow("Persistent mutation-capable agents are deferred");
  });

  test("blocks persistent agents when project resources are not trusted", async () => {
    const tools: any[] = [];
    let started = false;
    registerAgentRuntimeTools({ registerTool(tool: unknown) { tools.push(tool); } } as any, {
      manager: {
        async start() {
          started = true;
          throw new Error("must not start");
        },
      } as any,
      exec: async () => { throw new Error("project discovery must not run"); },
      getRoutingState: () => ({ policy: "balanced" }),
    });
    const start = tools.find((tool) => tool.name === "workbench_agent_start");
    const notices: string[] = [];
    const result = await start.execute("call", { agent: "codebase-explorer", task: "Inspect the repository map." }, undefined, undefined, {
      cwd: "/project",
      hasUI: true,
      isProjectTrusted: () => false,
      ui: { notify(message: string) { notices.push(message); } },
    });
    const expected = "This project is not trusted. Project .pi resources and packages are ignored. Use /trust to save a trust decision, then restart pi.";
    expect(result.content[0]?.text).toBe(expected);
    expect(result.details).toEqual({ blocked: true, reason: "project-trust-required" });
    expect(notices).toEqual([expected]);
    expect(started).toBe(false);
  });

  test("starts persistent read-only Bash-capable profiles", async () => {
    const tools: any[] = [];
    let started: any;
    registerAgentRuntimeTools({
      registerTool(tool: unknown) { tools.push(tool); },
      appendEntry() {},
    } as any, {
      manager: {
        async start(request: unknown) {
          started = request;
          return { runId: "agent-codebase-explorer-1", completion: new Promise(() => {}) };
        },
      } as any,
      exec: async () => ({ stdout: "/project", stderr: "", code: 0 }),
      getRoutingState: () => ({ policy: "balanced" }),
    });
    const start = tools.find((tool) => tool.name === "workbench_agent_start");
    const result = await start.execute("call", { agent: "codebase-explorer", task: "Inspect the repository map." }, undefined, undefined, {
      cwd: "/project",
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { notify() {} },
    });
    expect(started).toMatchObject({
      projectRoot: "/project",
      agent: { id: "codebase-explorer", readOnly: true, allowBash: true },
      task: "Inspect the repository map.",
    });
    expect(result.details.runId).toBe("agent-codebase-explorer-1");
    await start.execute("astra", { agent: "codebase-explorer", task: "Inspect UI", model: "openai-codex/gpt-6-astra:high" }, undefined, undefined, {
      cwd: "/project", hasUI: true, isProjectTrusted: () => true, ui: { notify() {} },
      modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6-astra" }] },
    });
    expect(started.agent.model).toBe("openai-codex/gpt-6-astra:high");
    started = undefined;
    await expect(start.execute("missing", { agent: "codebase-explorer", task: "Inspect UI", model: "openai-codex/missing" }, undefined, undefined, {
      cwd: "/project", hasUI: true, isProjectTrusted: () => true, ui: { notify() {} }, modelRegistry: { getAvailable: () => [] },
    })).rejects.toThrow("No substitute");
    expect(started).toBeUndefined();
  });

  test("keeps the legacy launcher seam as a facade over the shared manager", async () => {
    const original = getDefaultAgentRunManager();
    let request: any;
    const fake = {
      async runToResult(value: unknown) {
        request = value;
        return { agentId: "planner", title: "Planner", output: "managed", exitCode: 0 };
      },
    };
    setDefaultAgentRunManager(fake as any);
    try {
      const result = await runSingleAgent(
        "/project",
        { id: "planner", title: "Planner", description: "Plans", triggers: [], readOnly: true },
        "system",
        "task",
      );
      expect(result.output).toBe("managed");
      expect(request).toMatchObject({ projectRoot: "/project", systemPrompt: "system", task: "task" });
    } finally {
      setDefaultAgentRunManager(original);
    }
  });

  test("routes council supervisor decisions through the authoritative manager", async () => {
    let request: any;
    const manager = {
      async start(value: unknown) {
        request = value;
        return {
          runId: "supervisor-run-1",
          completion: Promise.resolve({
            agentId: "council-supervisor",
            title: "Council Supervisor",
            output: '<workbench-decision>{"action":"delegate","phase":"review","roles":["quality-reviewer"],"rationale":"Independent review is required."}</workbench-decision>',
            exitCode: 0,
          }),
        };
      },
      async cancel() {},
    };
    const updates: unknown[] = [];
    const supervisor = new SupervisorClient("/project", { updateJob: (...args: unknown[]) => updates.push(args) } as any, manager as any);
    const decision = await supervisor.decide("Choose the next phase.");
    expect(decision).toMatchObject({ action: "delegate", phase: "review", roles: ["quality-reviewer"] });
    expect(request).toMatchObject({ projectRoot: "/project", agent: { id: "council-supervisor", readOnly: true } });
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });
});
