import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { registerCoordinatorExecution } from "../coordinator-execution.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { getWorkflowPaths, loadCurrentWorkflowPlan, saveWorkflowPlan } from "../workflow-state.ts";
import { runCheck, workspaceSnapshot } from "../verification.ts";
import { setTaskModelPreference } from "../task-model-policy.ts";

async function setup(verification: (call: number) => void | string | Promise<void | string> = () => {}, implementationResult: { exitCode?: number; cancelled?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "execution-recovery-"));
  await fs.writeFile(path.join(root, "code.txt"), "original source");
  const workflowPaths = getWorkflowPaths(path.join(root, ".pi/pi-workbench"));
  const id = "execution-test";
  const timestamp = new Date().toISOString();
  await saveWorkflowPlan(workflowPaths, { version: 1, id, task: "Build behavior", plan: "# Approved plan", status: "executing", interviewNotes: "", createdAt: timestamp, updatedAt: timestamp, reviewRounds: 1, planPath: "", execution: { startedAt: timestamp, attempts: 0, verificationPassed: false } });
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<() => void>>();
  let calls = 0;
  const implementations: string[] = [];
  const ctx: any = { cwd: root, hasUI: true, isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6-astra" }] }, ui: { setStatus() {}, confirm: async () => true } };
  registerCoordinatorExecution({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendUserMessage() {},
  } as any, {
    resolveProject: async () => ({ root, workflowPaths, config: { ...DEFAULT_CONFIG, workflowMode: "focused", workflowMaxFixLoops: 0 } }),
    withLease: async (_root, _operation, work) => work(),
    implement: async (_project, _state, _task, model) => {
      implementations.push(model);
      await fs.writeFile(path.join(root, "code.txt"), "implemented source");
      return { agentId: "implementer", title: "Implementation", exitCode: 0, output: "Done", ...implementationResult };
    },
    verify: async () => {
      const verdict = await verification(++calls);
      const check = await runCheck({ argv: [process.execPath, "-e", "process.exit(0)"], criterionIds: ["behavior"], kind: "automated-test" }, { projectRoot: root, evidenceDir: path.join(root, ".pi/pi-workbench/checks"), runId: "native-test" });
      return { reviews: [{ agentId: "technical-reviewer", title: "Review", exitCode: 0, output: verdict ?? "<code-verdict>PASS</code-verdict>" }], verification: { agentId: "verifier", title: "Verification", exitCode: 0, output: "<verified/>", verification: { receipts: [check.receipt], snapshot: await workspaceSnapshot(root) } } };
    },
    report() {},
  });
  const run = (action: string, extra: object = {}, signal?: AbortSignal) => tools.get("workbench_execute").execute("test", { action, planId: id, assessment: "Inspected the current code and native check evidence", ...extra }, signal, undefined, ctx);
  return { root, id, workflowPaths, run, implementations,
    inspect: async () => [(await run("inspect", { paths: ["code.txt"] })).details.receipt.id],
    reload: () => { for (const handler of handlers.get("session_start") ?? []) handler(); },
    state: () => loadCurrentWorkflowPlan(workflowPaths), calls: () => calls,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("execution recovers final-cycle passing gates after reload without replaying writers", async () => {
  const item = await setup();
  try {
    const ids = await item.inspect();
    expect((await item.run("verify", { evidenceIds: ids })).details.status).toBe("verification_passed");
    item.reload();
    await expect(item.run("complete", { evidenceIds: ids })).rejects.toThrow("native review");
    await expect(item.run("recover", { evidenceIds: ids })).rejects.toThrow("Unknown");
    const evidenceIds = await item.inspect();
    expect((await item.run("recover", { evidenceIds })).details.status).toBe("verification_passed");
    expect((await item.state())!.execution!.attempts).toBe(1);
    expect((await item.state())!.execution!.review!.recoveryAttempts).toBe(1);
    expect((await item.run("complete", { evidenceIds })).details.status).toBe("verified");
    expect(item.implementations).toEqual([]);
    expect(item.calls()).toBe(2);
  } finally { await item.cleanup(); }
});

test("interrupted verification has one durable recovery allowance", async () => {
  const item = await setup(() => { throw new Error("transport failure"); });
  try {
    let evidenceIds = await item.inspect();
    await expect(item.run("verify", { evidenceIds })).rejects.toThrow("transport failure");
    expect((await item.state())!.execution!.review!.status).toBe("interrupted");
    item.reload(); evidenceIds = await item.inspect();
    await expect(item.run("recover", { evidenceIds })).rejects.toThrow("transport failure");
    item.reload(); evidenceIds = await item.inspect();
    await expect(item.run("recover", { evidenceIds })).rejects.toThrow("No recovery remains");
    expect(item.calls()).toBe(2);
  } finally { await item.cleanup(); }
});

test("changed workspace and stale or invented parent evidence cannot authorize recovery", async () => {
  const item = await setup();
  try {
    await expect(item.run("verify", { evidenceIds: ["forged"] })).rejects.toThrow("Unknown");
    const ids = await item.inspect();
    await item.run("verify", { evidenceIds: ids }); item.reload();
    await fs.writeFile(path.join(item.root, "code.txt"), "unreviewed change");
    const evidenceIds = await item.inspect();
    await expect(item.run("recover", { evidenceIds })).rejects.toThrow("unchanged");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("parent read becomes stale after mutation and malformed review gets only fresh bounded recovery", async () => {
  const item = await setup(call => call === 1 ? "I approve but forgot the protocol" : undefined);
  try {
    const stale = await item.inspect();
    await fs.writeFile(path.join(item.root, "code.txt"), "new source");
    await expect(item.run("verify", { evidenceIds: stale })).rejects.toThrow("stale");
    expect(item.calls()).toBe(0);
    const evidenceIds = await item.inspect();
    expect((await item.run("verify", { evidenceIds })).details.status).toBe("verification_protocol_invalid");
    expect((await item.state())!.execution!.review!.status).toBe("interrupted");
    expect((await item.run("recover", { evidenceIds })).details.status).toBe("verification_passed");
    item.reload();
    await expect(item.run("recover", { evidenceIds: await item.inspect() })).rejects.toThrow("No recovery remains");
    expect(item.calls()).toBe(2);
  } finally { await item.cleanup(); }
});

test("cancelled and rejected verification cannot recover", async () => {
  const controller = new AbortController();
  const cancelled = await setup(() => { controller.abort(); });
  try {
    const evidenceIds = await cancelled.inspect();
    await expect(cancelled.run("verify", { evidenceIds }, controller.signal)).rejects.toThrow();
    expect((await cancelled.state())!.execution!.review!.status).toBe("cancelled");
    expect((await cancelled.state())!.status).toBe("cancelled");
    await expect(cancelled.run("recover", { evidenceIds })).rejects.toThrow("no longer executing");
    expect(cancelled.calls()).toBe(1);
  } finally { await cancelled.cleanup(); }
  const rejected = await setup(() => "<code-verdict>CHANGES_REQUIRED</code-verdict>");
  try {
    const evidenceIds = await rejected.inspect();
    expect((await rejected.run("verify", { evidenceIds })).details.status).toBe("changes_required");
    await expect(rejected.run("recover", { evidenceIds })).rejects.toThrow("no longer executing");
    expect(rejected.calls()).toBe(1);
  } finally { await rejected.cleanup(); }
});

test("design brief requires both native source and visual evidence before review", async () => {
  const item = await setup();
  try {
    const state = (await item.state())!;
    state.designBrief = { direction: "Paper and ink", hierarchy: "Identity first", interactions: "Keyboard controls", responsiveAccessibility: "Reduced motion", constraints: "JSON facts only" };
    await saveWorkflowPlan(item.workflowPaths, state);
    const evidenceIds = await item.inspect();
    await expect(item.run("verify", { evidenceIds })).rejects.toThrow("visual evidence");
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      let crc = 0xffffffff;
      for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
      size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
      return Buffer.concat([size, body, checksum]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
    const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
    const artifactPath = path.join(item.root, ".pi/pi-workbench/capture.png");
    await fs.writeFile(artifactPath, image);
    const visual = await item.run("visual", { artifactPath, route: "/", viewport: { width: 390, height: 844 }, observations: ["Caller observed keyboard navigation"] });
    expect(visual.content.some((part: any) => part.type === "image")).toBe(true);
    expect(visual.details.receipt.provenance).toBe("caller-supplied-image");
    await expect(item.run("verify", { evidenceIds: [visual.details.receipt.id] })).rejects.toThrow("source inspection");
    expect(item.calls()).toBe(0);
    expect((await item.run("verify", { evidenceIds: [...evidenceIds, visual.details.receipt.id] })).details.status).toBe("verification_passed");
  } finally { await item.cleanup(); }
});

test("late old-session verification result cannot create a completion ticket", async () => {
  let item: Awaited<ReturnType<typeof setup>>;
  item = await setup(() => { item.reload(); });
  try {
    const evidenceIds = await item.inspect();
    await expect(item.run("verify", { evidenceIds })).rejects.toThrow("session changed");
    await expect(item.run("complete", { evidenceIds: await item.inspect() })).rejects.toThrow("native review");
  } finally { await item.cleanup(); }
});

test("implementation handoff observes dirty baseline and honors durable UI model pin", async () => {
  const item = await setup();
  try {
    await fs.writeFile(path.join(item.root, "unrelated.txt"), "preexisting work");
    await setTaskModelPreference(item.workflowPaths, (await item.state())!, { domain: "ui-ux", actions: ["implement", "repair"], model: "openai-codex/gpt-6-astra:high", reason: "User requested Astra for UI work" });
    item.reload();
    const response = await item.run("implement", { task: "Update source", domain: "ui-ux", paths: ["code.txt"] });
    expect(item.implementations).toEqual(["openai-codex/gpt-6-astra:high"]);
    expect(response.details.handoff.changes.changes).toEqual([{ path: "code.txt", kind: "modified" }]);
    expect(response.details.handoff.scopeAnomalies).toEqual([]);
    expect(response.details.handoff.termination).toBe("completed");
    expect(response.details.handoff.changes.authorship).toBe("unattributed");
  } finally { await item.cleanup(); }
});

test("native failed and cancelled writer results never claim completed handoffs", async () => {
  for (const cancelled of [false, true]) {
    const item = await setup(undefined, { exitCode: cancelled ? 0 : 3, cancelled });
    try {
      await expect(item.run("implement", { task: "Update source", model: "openai-codex/gpt-6-astra:high" })).rejects.toThrow(cancelled ? "Implementation cancelled" : "Implementation failed");
      const directory = path.join(item.workflowPaths.runs, item.id);
      const handoffName = (await fs.readdir(directory)).find((name) => name.startsWith("handoff-"))!;
      const handoff = JSON.parse(await fs.readFile(path.join(directory, handoffName), "utf8"));
      expect(handoff.termination).toBe(cancelled ? "cancelled" : "failed");
      expect(handoff.changes.changes).toEqual([{ path: "code.txt", kind: "modified" }]);
      expect((await item.state())!.status).toBe(cancelled ? "cancelled" : "executing");
      if (cancelled) await expect(item.run("implement", { task: "Replay", model: "openai-codex/gpt-6-astra:high" })).rejects.toThrow("no longer executing");
      expect(item.calls()).toBe(0);
    } finally { await item.cleanup(); }
  }
});
