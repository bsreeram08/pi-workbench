import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentRunManager, buildAgentChildEnvironment, defaultAgentInvocation } from "../agent-run-manager.ts";
import { AgentRunStore, digestAgentRunText } from "../agent-run-store.ts";
import type { AgentSpec } from "../types.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-agent-rpc.mjs");
const AGENT: AgentSpec = {
  id: "planner",
  title: "Planner",
  description: "Plans",
  triggers: [],
  readOnly: true,
};

async function setup(
  mode = "complete",
  delay = 0,
  storeFactory: (root: string) => AgentRunStore = (root) => new AgentRunStore(root),
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-run-manager-")));
  const project = path.join(root, "project");
  const records = path.join(root, "records");
  const envOutput = path.join(root, "child-env.json");
  await fs.mkdir(project);
  let launchArgs: string[] = [];
  const manager = new AgentRunManager({
    store: storeFactory(records),
    invocation: (args) => {
      launchArgs = [...args];
      return {
        command: process.execPath,
        args: [FIXTURE, ...args, "--fake-mode", mode, "--fake-delay", String(delay), "--env-output", envOutput],
      };
    },
    environment: {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      HOME: "/parent/home",
      NODE_OPTIONS: "--require=/tmp/evil.js",
      GITHUB_TOKEN: "secret",
      NPM_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      CMUX_SURFACE_ID: "surface:secret",
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    },
    terminationGraceMs: 30,
    killGraceMs: 60,
  });
  return { root, project: await fs.realpath(project), manager, envOutput, launchArgs: () => launchArgs };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

describe("AgentRunManager", () => {
  test("a resumed writer cannot return old transcript text without a fresh assistant response", async () => {
    const item = await setup("continuation-stale");
    try {
      execFileSync("git", ["init", "-q", item.project]);
      const writerBinding = { planId: "portfolio", taskDigest: digestAgentRunText("portfolio") };
      const request = { projectRoot: item.project, agent: { ...AGENT, id: "implementer", readOnly: false, model: "openai-codex/gpt-6-astra:high" }, systemPrompt: "Implement.", task: "Build.", runContext: { writerBinding } };
      const first = await item.manager.runToResult(request);
      expect(first.exitCode).toBe(0);
      const result = await item.manager.runToResult({ ...request, task: "Repair.", runContext: { writerBinding, continuation: { runId: first.runId!, expectedWorkspaceSnapshot: first.continuation!.workspaceSnapshot } } });
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain("fresh assistant response");
      expect(result.continuation).toBeUndefined();
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });
  test("lifecycle changes fence late checkpoint issuance and continuation launches", async () => {
    for (const phase of ["terminal", "launch"] as const) {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const paused = new Promise<void>((resolve) => { reached = resolve; });
      let armed = phase === "terminal";
      class PausingStore extends AgentRunStore {
        override async save(paths: Parameters<AgentRunStore["save"]>[0], record: Parameters<AgentRunStore["save"]>[1]) {
          if (armed && phase === "terminal" && record.status === "completed") { armed = false; reached(); await gate; }
          return super.save(paths, record);
        }
        override async writeSystemPrompt(paths: Parameters<AgentRunStore["writeSystemPrompt"]>[0], prompt: string) {
          if (armed && phase === "launch") { armed = false; reached(); await gate; }
          return super.writeSystemPrompt(paths, prompt);
        }
      }
      const item = await setup("continuation", 0, (root) => new PausingStore(root));
      try {
        execFileSync("git", ["init", "-q", item.project]);
        const writerBinding = { planId: "portfolio", taskDigest: digestAgentRunText("portfolio") };
        const request = { projectRoot: item.project, agent: { ...AGENT, id: "implementer", readOnly: false, model: "openai-codex/gpt-6-astra:high" }, systemPrompt: "Implement.", task: "Build.", runContext: { writerBinding } };
        if (phase === "terminal") {
          const started = await item.manager.start(request);
          await paused;
          const shuttingDown = item.manager.shutdown();
          release();
          await shuttingDown;
          expect((await started.completion).continuation).toBeUndefined();
        } else {
          const first = await item.manager.runToResult(request);
          armed = true;
          const pending = item.manager.start({ ...request, task: "Repair.", runContext: { writerBinding, continuation: { runId: first.runId!, expectedWorkspaceSnapshot: first.continuation!.workspaceSnapshot } } });
          const outcome = pending.then(() => "launched", (error: Error) => error.message);
          await paused;
          await item.manager.recover(item.project);
          release();
          expect(await outcome).toContain("lifecycle changed");
        }
      } finally { release(); await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
    }
  });
  test("continues a closed writer in a fresh private session with only the new correction prompt", async () => {
    const item = await setup("continuation");
    try {
      execFileSync("git", ["init", "-q", item.project]);
      const writer = { ...AGENT, id: "implementer", readOnly: false, model: "openai-codex/gpt-6-astra:high" };
      const writerBinding = { planId: "portfolio", taskDigest: digestAgentRunText("portfolio task") };
      const request = { projectRoot: item.project, agent: writer, systemPrompt: "Implement the approved task.", task: "ORIGINAL_ASSIGNMENT", runContext: { writerBinding } };
      const first = await item.manager.runToResult(request);
      expect(first.exitCode).toBe(0);
      expect(first.continuation?.runId).toBe(first.runId);
      const before = (await item.manager.store.list(item.project)).find((record) => record.runId === first.runId)!;
      const original = await fs.readFile(before.sessionFile!, "utf8");
      const repaired = await item.manager.runToResult({ ...request, task: "CORRECTION_ONLY", runContext: { writerBinding, continuation: { runId: first.runId!, expectedWorkspaceSnapshot: first.continuation!.workspaceSnapshot } } });
      expect(repaired.exitCode).toBe(0);
      expect(repaired.runId).not.toBe(first.runId);
      const restored = item.launchArgs()[item.launchArgs().indexOf("--session") + 1]!;
      const text = await fs.readFile(restored, "utf8");
      expect(text.match(/ORIGINAL_ASSIGNMENT/g)).toHaveLength(1);
      expect(text.match(/CORRECTION_ONLY/g)).toHaveLength(1);
      expect(JSON.parse(text.split("\n")[0]!).id).toBe(repaired.runId);
      expect(await fs.readFile(before.sessionFile!, "utf8")).toBe(original);
      await expect(item.manager.start({ ...request, runContext: { writerBinding, continuation: { runId: first.runId!, expectedWorkspaceSnapshot: first.continuation!.workspaceSnapshot } } })).rejects.toThrow("already consumed");
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });

  test("writer continuation rejects changed task, model, tools, workspace, transcript, and read-only reuse", async () => {
    for (const change of ["binding", "model", "tools", "workspace", "transcript", "corrupt", "symlink", "read-only", "recovery", "shutdown"] as const) {
      const item = await setup("continuation");
      try {
        execFileSync("git", ["init", "-q", item.project]);
        const writerBinding = { planId: "portfolio", taskDigest: digestAgentRunText("portfolio task") };
        const writer = { ...AGENT, id: "implementer", readOnly: false, model: "openai-codex/gpt-6-astra:high" };
        const request = { projectRoot: item.project, agent: writer, systemPrompt: "Implement.", task: "Build.", runContext: { writerBinding } };
        const first = await item.manager.runToResult(request);
        expect(first.continuation).toBeDefined();
        if (change === "workspace") await fs.writeFile(path.join(item.project, "unexpected.txt"), "another writer");
        if (change === "transcript") {
          const record = (await item.manager.store.list(item.project)).find((record) => record.runId === first.runId)!;
          await fs.appendFile(record.sessionFile!, `${JSON.stringify({ type: "message", unexpected: true })}\n`);
        }
        if (change === "corrupt" || change === "symlink") {
          const record = (await item.manager.store.list(item.project)).find((record) => record.runId === first.runId)!;
          if (change === "corrupt") await fs.writeFile(record.sessionFile!, "not JSON\n");
          else {
            const outside = path.join(item.root, "outside-session.jsonl");
            await fs.copyFile(record.sessionFile!, outside);
            await fs.unlink(record.sessionFile!);
            await fs.symlink(outside, record.sessionFile!);
          }
        }
        if (change === "recovery") await item.manager.recover(item.project);
        if (change === "shutdown") await item.manager.shutdown();
        await expect(item.manager.start({
          ...request, task: "Repair.",
          agent: { ...writer, ...(change === "model" ? { model: "openai-codex/gpt-5.6-luna:low" } : {}), ...(change === "tools" ? { allowBash: true } : {}), ...(change === "read-only" ? { readOnly: true } : {}) },
          runContext: { writerBinding: { ...writerBinding, ...(change === "binding" ? { planId: "other" } : {}) }, continuation: { runId: first.runId!, expectedWorkspaceSnapshot: first.continuation!.workspaceSnapshot } },
        })).rejects.toThrow();
      } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
    }
  });

  test("writer repair chains are bounded and checkpoints cannot be recovered by a new manager", async () => {
    const item = await setup("continuation");
    try {
      execFileSync("git", ["init", "-q", item.project]);
      const writerBinding = { planId: "portfolio", taskDigest: digestAgentRunText("portfolio task") };
      const request = { projectRoot: item.project, agent: { ...AGENT, id: "implementer", readOnly: false, model: "openai-codex/gpt-6-astra:high" }, systemPrompt: "Implement.", task: "Build.", runContext: { writerBinding } };
      let result = await item.manager.runToResult(request);
      const other = new AgentRunManager();
      await expect(other.start({ ...request, runContext: { writerBinding, continuation: { runId: result.runId!, expectedWorkspaceSnapshot: result.continuation!.workspaceSnapshot } } })).rejects.toThrow("previous parent session");
      for (let turn = 0; turn < 3; turn++) {
        expect(result.continuation).toBeDefined();
        result = await item.manager.runToResult({ ...request, task: `Repair ${turn}`, runContext: { writerBinding, continuation: { runId: result.runId!, expectedWorkspaceSnapshot: result.continuation!.workspaceSnapshot } } });
        expect(result.exitCode).toBe(0);
      }
      expect(result.continuation).toBeUndefined();
    } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
  });
  test("returns correlated native verification receipts and rejects changed or unmatched evidence", async () => {
    for (const mode of ["check-valid", "check-tampered", "check-unmatched"]) {
      const item = await setup(mode);
      try {
        execFileSync("git", ["init", "-q", item.project]);
        await fs.writeFile(path.join(item.project, "source.txt"), "source");
        const handle = await item.manager.start({ projectRoot: item.project, agent: { ...AGENT, allowBash: true }, systemPrompt: "Verify.", task: "Run checks." });
        const result = await handle.completion;
        if (mode === "check-valid") {
          expect(result.exitCode).toBe(0);
          expect(result.verification?.receipts).toHaveLength(1);
          expect(result.verification?.receipts[0].snapshotAfter).toBe(result.verification?.snapshot);
        } else expect(result.exitCode).not.toBe(0);
      } finally { await item.manager.shutdown(); await fs.rm(item.root, { recursive: true, force: true }); }
    }
  });
  test("launches the Pi CLI instead of reusing arbitrary Node or Bun embedding scripts", () => {
    expect(defaultAgentInvocation(["--mode", "rpc"], "/usr/bin/node")).toEqual({ command: "pi", args: ["--mode", "rpc"] });
    expect(defaultAgentInvocation(["--mode", "rpc"], "/opt/homebrew/bin/bun")).toEqual({ command: "pi", args: ["--mode", "rpc"] });
    expect(defaultAgentInvocation(["--mode", "rpc"], "/Applications/Pi.app/pi")).toEqual({ command: "/Applications/Pi.app/pi", args: ["--mode", "rpc"] });
  });

  test("loads fast mode for supported Sol and Luna routes after stripping thinking suffixes", async () => {
    for (const route of ["openai-codex/gpt-5.6-sol:high", "openai-codex/gpt-5.6-luna:max"]) {
      const item = await setup();
      try {
        const handle = await item.manager.start({
          projectRoot: item.project,
          agent: { ...AGENT, model: route },
          systemPrompt: "Plan safely.",
          task: "Return a result.",
          runId: "fast-supported",
        });
        await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
        expect(item.launchArgs().some((value) => value.endsWith("child-fast-mode.ts"))).toBe(true);
        expect(item.launchArgs().filter((value) => value === "--extension")).toHaveLength(2);
        expect(item.launchArgs().filter((value) => value === "--no-extensions")).toHaveLength(1);
      } finally {
        await item.manager.shutdown();
        await fs.rm(item.root, { recursive: true, force: true });
      }
    }
  });

  test("inherits fast mode for a supported manager default model", async () => {
    const item = await setup();
    try {
      item.manager.setDefaultModel("openai-codex/gpt-5.6-luna:low");
      const handle = await item.manager.start({
        projectRoot: item.project, agent: AGENT, systemPrompt: "Plan safely.", task: "Return a result.", runId: "fast-default",
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
      expect(item.launchArgs().some((value) => value.endsWith("child-fast-mode.ts"))).toBe(true);
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("omits fast mode for Terra, non-GPT providers, and explicit per-agent disablement", async () => {
    const cases: AgentSpec[] = [
      { ...AGENT, model: "openai-codex/gpt-5.6-terra:high" },
      { ...AGENT, model: "anthropic/claude-opus-4-1:high" },
      { ...AGENT, model: "openai-codex/gpt-5.6-sol:high", fastMode: false },
    ];
    for (const agent of cases) {
      const item = await setup();
      try {
        const handle = await item.manager.start({
          projectRoot: item.project, agent, systemPrompt: "Plan safely.", task: "Return a result.", runId: "fast-unsupported",
        });
        await expect(handle.completion).resolves.toMatchObject({ exitCode: 0 });
        expect(item.launchArgs().some((value) => value.endsWith("child-fast-mode.ts"))).toBe(false);
        expect(item.launchArgs().filter((value) => value === "--extension")).toHaveLength(1);
        expect(item.launchArgs().filter((value) => value === "--no-extensions")).toHaveLength(1);
      } finally {
        await item.manager.shutdown();
        await fs.rm(item.root, { recursive: true, force: true });
      }
    }
  });

  test("awaits the correlated final-text response and persists a session checkpoint", async () => {
    const item = await setup("complete", 75);
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Plan safely.",
        task: "Return a result.",
        runId: "run-complete",
      });
      const result = await handle.completion;
      expect(result).toMatchObject({ exitCode: 0, output: "verified fake output" });
      const [status] = await item.manager.status(item.project, handle.runId);
      expect(status).toMatchObject({ status: "completed", sessionPresent: true, exitCode: 0 });
      const record = await item.manager.store.load(item.project, handle.runId);
      expect(record?.sessionFile).toStartWith(record!.sessionDir);
      expect((await fs.lstat(record!.sessionFile!)).mode & 0o077).toBe(0);
      expect(record).toMatchObject({ runtime: "headless-rpc", runtimePath: FIXTURE });
      expect(record?.runtimeDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(record?.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("does not fall back to a hidden RPC child when an available interactive host fails", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-run-manager-cmux-fail-")));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    let invoked = 0;
    const manager = new AgentRunManager({
      store: new AgentRunStore(path.join(root, "records")),
      sessionHost: {
        interactive: true,
        async prepare() { throw new Error("terminal creation failed"); },
        focus() {},
      },
      invocation: (args) => { invoked++; return { command: process.execPath, args: [FIXTURE, ...args] }; },
      environment: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR },
      defaultModel: "fixture/default:high",
    });
    try {
      await expect(manager.start({ projectRoot: project, agent: AGENT, systemPrompt: "Plan.", task: "Must not hide.", runId: "cmux-fail" }))
        .rejects.toThrow("terminal creation failed");
      expect(invoked).toBe(1);
    } finally { await manager.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
  });

  test("constructs a minimal child environment", async () => {
    const item = await setup();
    try {
      const memoryProjectRoot = path.join(item.root, "authoritative-main");
      await fs.mkdir(memoryProjectRoot);
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Plan safely.",
        task: "Inspect environment.",
        runId: "run-environment",
        runContext: { memoryProjectRoot },
      });
      await handle.completion;
      const environment = JSON.parse(await fs.readFile(item.envOutput, "utf8"));
      expect(environment.PI_OFFLINE).toBe("1");
      expect(environment.PI_WORKBENCH_RUN_ID).toStartWith("run-environment-");
      expect(environment.PI_WORKBENCH_PROJECT_ROOT).toBe(item.project);
      expect(environment.PI_WORKBENCH_MEMORY_PROJECT_ROOT).toBe(memoryProjectRoot);
      expect(environment.HOME).not.toBe("/parent/home");
      for (const forbidden of ["NODE_OPTIONS", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "CMUX_SURFACE_ID"]) {
        expect(environment[forbidden]).toBeUndefined();
      }
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("enters waiting_for_parent and accepts one matching answer", async () => {
    const item = await setup("question");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Ask when blocked.",
        task: "ASK",
        runId: "run-question",
        runContext: { allowParentQuestions: true },
      });
      await waitFor(async () => (await item.manager.status(item.project, handle.runId))[0]?.status === "waiting_for_parent");
      const [waiting] = await item.manager.status(item.project, handle.runId);
      expect(waiting.question?.question).toBe("Which path?");
      await expect(item.manager.answer(handle.runId, "wrong-question", "src")).rejects.toThrow("does not match");
      const delivery = item.manager.answer(handle.runId, waiting.question!.id, "src");
      await expect(item.manager.answer(handle.runId, waiting.question!.id, "duplicate")).rejects.toThrow("already being delivered");
      await delivery;
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, output: "verified fake output" });
      await expect(item.manager.answer(handle.runId, waiting.question!.id, "again")).rejects.toThrow("not active");
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("permits only one parent question for the full run", async () => {
    const item = await setup("double-question");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Ask once when blocked.",
        task: "ASK TWICE",
        runId: "run-double-question",
        runContext: { allowParentQuestions: true },
      });
      await waitFor(async () => (await item.manager.status(item.project, handle.runId))[0]?.status === "waiting_for_parent");
      const [waiting] = await item.manager.status(item.project, handle.runId);
      await item.manager.answer(handle.runId, waiting.question!.id, "src");
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1, error: "Agent requested more than one parent answer for this run." });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "multiple_questions" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("atomically rejects concurrent parent-question admission", async () => {
    const item = await setup("concurrent-question");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Ask once when blocked.",
        task: "ASK CONCURRENTLY",
        runId: "run-concurrent-question",
        runContext: { allowParentQuestions: true },
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1, error: "Agent requested more than one parent answer for this run." });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "multiple_questions" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("rejects oversized parent-question request identities at the RPC boundary", async () => {
    const item = await setup("long-question-id");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Ask when blocked.",
        task: "ASK",
        runId: "run-long-question",
        runContext: { allowParentQuestions: true },
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "invalid_ui_request" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("fails closed on malformed child protocol", async () => {
    const item = await setup("malformed");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Plan safely.",
        task: "Break protocol.",
        runId: "run-malformed",
      });
      const result = await handle.completion;
      expect(result.exitCode).not.toBe(0);
      expect(result.error).toContain("Malformed Agent RPC JSON");
      const [status] = await item.manager.status(item.project, handle.runId);
      expect(status).toMatchObject({ status: "failed", errorCode: "malformed_json" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("requires exact final text and a non-symlinked private session checkpoint", async () => {
    for (const [mode, errorCode] of [["blank-final", "invalid_final_text"], ["session-symlink", "final_handshake_failed"]] as const) {
      const item = await setup(mode);
      try {
        const handle = await item.manager.start({
          projectRoot: item.project,
          agent: AGENT,
          systemPrompt: "Finish safely.",
          task: "Return a result.",
          runId: `run-${mode}`,
        });
        await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
        expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode });
      } finally {
        await item.manager.shutdown();
        await fs.rm(item.root, { recursive: true, force: true });
      }
    }
  });

  test("keeps correlated final text immutable when a late message event arrives", async () => {
    const item = await setup("late-message");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Finish safely.",
        task: "Return an exact result.",
        runId: "run-late-message",
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 0, output: "verified fake output" });
      const record = await item.manager.store.load(item.project, handle.runId);
      expect(record?.outputDigest).toBe(digestAgentRunText("verified fake output"));
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("fails before prompting when the child loadout does not match", async () => {
    const item = await setup("loadout-mismatch");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Plan safely.",
        task: "Must not run.",
        runId: "run-loadout-mismatch",
      });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]).toMatchObject({ status: "failed", errorCode: "loadout_mismatch" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("keeps requested job IDs distinct in durable run storage", async () => {
    const item = await setup();
    try {
      const first = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Plan.", task: "One.", runId: "reused-job" });
      await first.completion;
      const second = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Plan.", task: "Two.", runId: "reused-job" });
      await second.completion;
      expect(first.runId).not.toBe(second.runId);
      expect((await item.manager.store.list(item.project)).filter((record) => record.runId.startsWith("reused-job-"))).toHaveLength(2);
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("does not overwrite an early terminal close with a starting record", async () => {
    const item = await setup("early-close");
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Plan.", task: "Exit.", runId: "early-close" });
      await expect(handle.completion).resolves.toMatchObject({ exitCode: 1 });
      expect((await item.manager.status(item.project, handle.runId))[0]?.status).toBe("failed");
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("persists cancellation only after the process exits", async () => {
    const item = await setup("hang");
    try {
      const handle = await item.manager.start({
        projectRoot: item.project,
        agent: AGENT,
        systemPrompt: "Wait.",
        task: "Hang.",
        runId: "run-cancel",
      });
      await item.manager.cancel(handle.runId);
      const during = (await item.manager.status(item.project, handle.runId))[0];
      expect(["cancelling", "terminating", "cancelled"]).toContain(during.status);
      const result = await handle.completion;
      expect(result).toMatchObject({ cancelled: true });
      expect((await item.manager.status(item.project, handle.runId))[0]?.status).toBe("cancelled");
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("still escalates cancellation when the cancelling record write fails", async () => {
    class FailingCancellationStore extends AgentRunStore {
      private failed = false;
      override async save(paths: Parameters<AgentRunStore["save"]>[0], record: Parameters<AgentRunStore["save"]>[1]) {
        if (!this.failed && record.status === "cancelling") {
          this.failed = true;
          throw new Error("injected cancellation persistence failure");
        }
        return super.save(paths, record);
      }
    }
    const item = await setup("hang", 0, (root) => new FailingCancellationStore(root));
    try {
      const handle = await item.manager.start({ projectRoot: item.project, agent: AGENT, systemPrompt: "Wait.", task: "Hang.", runId: "cancel-write-failure" });
      await expect(item.manager.cancel(handle.runId)).rejects.toThrow("injected cancellation persistence failure");
      await expect(handle.completion).resolves.toMatchObject({ cancelled: true });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("marks an unowned nonterminal record interrupted during recovery", async () => {
    const item = await setup();
    try {
      const paths = await item.manager.store.prepare(item.project, "run-recovery");
      const now = "2026-08-28T00:00:00.000Z";
      await item.manager.store.save(paths, {
        version: 1,
        runId: "run-recovery",
        agentId: "planner",
        title: "Planner",
        projectRoot: item.project,
        cwd: item.project,
        groupId: "group-one",
        status: "running",
        createdAt: now,
        updatedAt: now,
        sequence: 4,
        taskDigest: "a".repeat(64),
        systemPromptDigest: "b".repeat(64),
        trustedCodeDigest: "c".repeat(64),
        tools: ["read"],
        readOnly: true,
        allowBash: false,
        sessionDir: paths.sessions,
        pid: 999_999,
        processStartIdentity: "missing process",
      });
      const recovered = await item.manager.recover(item.project);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ status: "interrupted", sequence: 5, errorCode: "parent-restarted" });
    } finally {
      await item.manager.shutdown();
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });
});

describe("buildAgentChildEnvironment", () => {
  test("omits parent credentials and loader hooks", () => {
    const environment = buildAgentChildEnvironment(
      { PATH: "/usr/bin", NODE_OPTIONS: "evil", OPENAI_API_KEY: "secret", PI_CODING_AGENT_DIR: "/safe/agent" },
      { root: "/run", record: "/run/record", systemPrompt: "/run/prompt", sessions: "/run/sessions", temporaryHome: "/run/home", temporaryDirectory: "/run/tmp" },
      { runId: "run", agentId: "agent", projectRoot: "/worktree", memoryProjectRoot: "/project", allowParentQuestions: false, readOnly: true },
    );
    expect(environment).toMatchObject({
      PATH: "/usr/bin", HOME: "/run/home", TMPDIR: "/run/tmp", PI_OFFLINE: "1",
      PI_WORKBENCH_PROJECT_ROOT: "/worktree", PI_WORKBENCH_MEMORY_PROJECT_ROOT: "/project",
      PI_WORKBENCH_READ_ONLY: "1",
    });
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });
});
