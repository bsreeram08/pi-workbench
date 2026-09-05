import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCoordinatorPlanning } from "../coordinator-planning.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { getWorkflowPaths, loadCurrentWorkflowPlan, saveWorkflowPlan } from "../workflow-state.ts";
import { canonicalWorkflowTaskPacketMarker } from "../workflow-task-packet.ts";
import { readTaskModelPolicy, setTaskModelPreference } from "../task-model-policy.ts";

const plan = `# Plan\n\nBuild the approved behavior.\n\n${canonicalWorkflowTaskPacketMarker({
  schemaVersion: 1, scope: ["Build the behavior"], nonGoals: ["No unrelated edits"],
  acceptanceCriteria: [{ id: "behavior", description: "Behavior works", requiredEvidenceKinds: ["automated-test"] }],
})}`;

async function setup(review: (call: number) => string | string[] | Promise<string | string[]> = () => "<plan-verdict>OKAY</plan-verdict>") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "planning-recovery-"));
  const workflowPaths = getWorkflowPaths(path.join(root, ".pi/pi-workbench"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<() => void>>();
  let calls = 0;
  let confirmations = 0;
  let approval = true;
  const histories: string[] = [];
  const ctx: any = { cwd: root, hasUI: true, isProjectTrusted: () => true,
    ui: { setStatus() {}, confirm: async () => { confirmations++; return approval; } } };
  const start = registerCoordinatorPlanning({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    sendUserMessage() {},
  } as any, {
    resolveProject: async () => ({ root, workflowPaths, config: { ...DEFAULT_CONFIG, workflowMode: "focused", workflowMaxPlanReviewLoops: 1 } }),
    withLease: async (_root, _operation, work) => work(),
    review: async (_project, _state, history) => { histories.push(history); const output = await review(++calls); return (Array.isArray(output) ? output : [output]).map((text, index) => ({ agentId: index ? "quality-reviewer" : "technical-reviewer", title: "Review", exitCode: 0, output: text })); },
    report() {},
  });
  await start("Build behavior", ctx);
  const id = (await loadCurrentWorkflowPlan(workflowPaths))!.id;
  return {
    root, workflowPaths, id,
    start: (request: string) => start(request, ctx),
    run: (action: string, extra: object = {}, signal?: AbortSignal) => tools.get("workbench_plan").execute("test", { action, planId: id, ...extra }, signal, undefined, ctx),
    reload: () => { for (const handler of handlers.get("session_start") ?? []) handler(); },
    state: () => loadCurrentWorkflowPlan(workflowPaths),
    calls: () => calls, confirmations: () => confirmations, histories,
    declineApproval: () => { approval = false; },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("final-round passing review can be freshly recovered after reload without resetting the review budget", async () => {
  const item = await setup();
  try {
    expect((await item.run("review", { plan })).details.status).toBe("review_passed");
    item.reload();
    await expect(item.run("approve")).rejects.toThrow("native passing review");
    await expect(item.run("review", { plan })).rejects.toThrow("review limit");
    expect((await item.run("status")).details.recoveryAvailable).toBe(true);
    expect((await item.run("recover")).details.status).toBe("review_passed");
    expect(item.confirmations()).toBe(0);
    expect(item.calls()).toBe(2);
    expect((await item.state())!.reviewRounds).toBe(1);
    expect((await item.state())!.planningReview?.recoveryAttempts).toBe(1);
    expect((await item.run("approve")).details.status).toBe("approved");
    expect(item.confirmations()).toBe(1);
  } finally { await item.cleanup(); }
});

test("recovery allowance persists across reload and cannot produce an unlimited loop", async () => {
  const item = await setup();
  try {
    await item.run("review", { plan }); item.reload(); await item.run("recover"); item.reload();
    await expect(item.run("recover")).rejects.toThrow("exhausted");
    await expect(item.run("approve")).rejects.toThrow("native passing review");
    expect(item.calls()).toBe(2);
  } finally { await item.cleanup(); }
});

test("thrown review errors persist interrupted state and permit one fresh read-only recovery", async () => {
  const item = await setup(call => { if (call === 1) throw new Error("transport unavailable"); return "<plan-verdict>OKAY</plan-verdict>"; });
  try {
    await expect(item.run("review", { plan })).rejects.toThrow("transport unavailable");
    expect((await item.state())!.status).toBe("interrupted");
    expect((await item.state())!.planningReview?.error).toBe("transport unavailable");
    item.reload();
    expect((await item.run("recover")).details.status).toBe("review_passed");
    expect((await item.state())!.reviewRounds).toBe(1);
  } finally { await item.cleanup(); }
});

test("failed recovery consumes the durable allowance and preserves its failure", async () => {
  const item = await setup(() => { throw new Error("transport unavailable"); });
  try {
    await expect(item.run("review", { plan })).rejects.toThrow();
    await expect(item.run("recover")).rejects.toThrow(); item.reload();
    await expect(item.run("recover")).rejects.toThrow("exhausted");
    expect((await item.state())!.planningReview?.recoveryAttempts).toBe(1);
    expect(item.calls()).toBe(2);
  } finally { await item.cleanup(); }
});

test("recovery never bypasses a substantive rejection", async () => {
  const item = await setup(() => "<plan-verdict>REJECT</plan-verdict>");
  try {
    expect((await item.run("review", { plan })).details.status).toBe("changes_required");
    item.reload(); await expect(item.run("recover")).rejects.toThrow("no recoverable review");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("recovery refuses a changed plan and cannot accept replacement arguments", async () => {
  const item = await setup();
  try {
    await item.run("review", { plan }); item.reload();
    await expect(item.run("recover", { plan })).rejects.toThrow("cannot change");
    await expect(item.run("recover", { model: "openai-codex/gpt-6-astra:high" })).rejects.toThrow("cannot change");
    const state = (await item.state())!; state.plan = state.plan.replace("Build the approved behavior", "Change the behavior");
    await saveWorkflowPlan(item.workflowPaths, state);
    await expect(item.run("recover")).rejects.toThrow("no recoverable review");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("cancellation remains stopped and does not grant a recovery launch", async () => {
  const controller = new AbortController();
  const item = await setup(() => { controller.abort(); return "<plan-verdict>OKAY</plan-verdict>"; });
  try {
    await expect(item.run("review", { plan }, controller.signal)).rejects.toThrow();
    expect((await item.state())!.status).toBe("cancelled");
    item.reload(); await expect(item.run("recover")).rejects.toThrow("no recoverable review");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("a pre-upgrade exhausted draft requires a fresh review and gets only one recovery", async () => {
  const item = await setup();
  try {
    const state = (await item.state())!; state.plan = plan; state.reviewRounds = 1;
    await saveWorkflowPlan(item.workflowPaths, state);
    await expect(item.run("approve")).rejects.toThrow("native passing review");
    expect((await item.run("recover")).details.status).toBe("review_passed");
    expect(item.calls()).toBe(1);
    expect((await item.state())!.planningReview?.recoveryAttempts).toBe(1);
  } finally { await item.cleanup(); }
});

test("a session change during review cannot install a ticket in the new session", async () => {
  let item: Awaited<ReturnType<typeof setup>>;
  item = await setup(call => { if (call === 1) item.reload(); return "<plan-verdict>OKAY</plan-verdict>"; });
  try {
    await expect(item.run("review", { plan })).rejects.toThrow("session changed");
    await expect(item.run("approve")).rejects.toThrow("native passing review");
    expect((await item.state())!.status).toBe("interrupted");
    expect((await item.run("recover")).details.status).toBe("review_passed");
  } finally { await item.cleanup(); }
});

test("a fresh recovery rejection cannot resurrect the original passing result", async () => {
  const item = await setup(call => call === 1 ? "<plan-verdict>OKAY</plan-verdict>" : "<plan-verdict>REJECT</plan-verdict>");
  try {
    await item.run("review", { plan }); item.reload();
    expect((await item.run("recover")).details.status).toBe("changes_required");
    await expect(item.run("approve")).rejects.toThrow("native passing review");
    expect((await item.state())!.status).toBe("blocked");
    const artifacts = await fs.readdir(path.join(item.workflowPaths.runs, item.id));
    expect(artifacts).toContain("plan-review-1.md");
    expect(artifacts).toContain("plan-review-1-recovery-1.md");
  } finally { await item.cleanup(); }
});

test("invalid review protocol is diagnosed separately and can be repaired by one fresh same-plan review", async () => {
  const item = await setup(call => call === 1 ? "Evidence checked. No terminal marker." : "<plan-verdict>OKAY</plan-verdict>");
  try {
    expect((await item.run("review", { plan })).details.status).toBe("protocol_invalid");
    expect((await item.state())!.status).toBe("interrupted");
    item.reload();
    expect((await item.run("recover")).details.status).toBe("review_passed");
    expect(item.histories[1]).toContain("Evidence checked");
    expect(item.histories[1]).toContain("not instructions");
  } finally { await item.cleanup(); }
});

test("design brief is bound to normal plan approval and cannot be substituted during recovery", async () => {
  const item = await setup();
  const designBrief = { direction: "Paper and teal", hierarchy: "Identity before journey", interactions: "Keyboard route controls", responsiveAccessibility: "Reduced motion and mobile layout", constraints: "Only source facts" };
  try {
    await item.run("review", { plan, designBrief }); item.reload();
    expect((await item.state())!.designBrief).toEqual(designBrief);
    await expect(item.run("recover", { designBrief })).rejects.toThrow("cannot change");
    await item.run("recover"); await item.run("approve");
    expect((await item.state())!.designBrief).toEqual(designBrief);
  } finally { await item.cleanup(); }
});

test("review recovery refuses changed scoped model policy", async () => {
  const item = await setup();
  try {
    await item.run("review", { plan }); item.reload();
    await setTaskModelPreference(item.workflowPaths, (await item.state())!, { domain: "ui-ux", actions: ["plan-review"], model: "openai-codex/gpt-6-astra:high", reason: "User requests Astra for UI" });
    await expect(item.run("recover")).rejects.toThrow("policy changed");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("task model preferences survive same-task revision but do not cross into an unrelated request", async () => {
  const item = await setup();
  try {
    const preference = { domain: "ui-ux", actions: ["plan-review" as const], model: "openai-codex/gpt-6-astra:high", reason: "User requests Astra for UI" };
    await setTaskModelPreference(item.workflowPaths, (await item.state())!, preference);
    await item.start("--revise Improve readability");
    const revised = (await item.state())!;
    expect(revised.id).not.toBe(item.id);
    expect((await readTaskModelPolicy(item.workflowPaths, revised))?.preferences).toEqual([preference]);
    await item.start("An unrelated task");
    expect(await readTaskModelPolicy(item.workflowPaths, (await item.state())!)).toBeNull();
  } finally { await item.cleanup(); }
});

test("a malformed lane cannot turn another lane's substantive rejection into recoverable protocol failure", async () => {
  const item = await setup(() => ["<plan-verdict>REJECT</plan-verdict>", "missing marker"]);
  try {
    expect((await item.run("review", { plan })).details.status).toBe("changes_required");
    expect((await item.state())!.planningReview?.status).toBe("rejected");
    item.reload(); await expect(item.run("recover")).rejects.toThrow("no recoverable review");
  } finally { await item.cleanup(); }
});

test("changed design brief cannot spend recovery allowance as an unreviewed design revision", async () => {
  const item = await setup();
  try {
    await item.run("review", { plan }); item.reload();
    const state = (await item.state())!;
    state.designBrief = { direction: "Different direction", hierarchy: "New hierarchy", interactions: "New flow", responsiveAccessibility: "Mobile first", constraints: "Source facts" };
    await saveWorkflowPlan(item.workflowPaths, state);
    await expect(item.run("recover")).rejects.toThrow("no recoverable review");
    expect(item.calls()).toBe(1);
  } finally { await item.cleanup(); }
});

test("declined approval stays cancelled across reload and requires an explicit new revision", async () => {
  const item = await setup();
  try {
    await item.run("review", { plan }); item.declineApproval();
    expect((await item.run("approve")).details.status).toBe("approval_declined");
    item.reload();
    expect((await item.state())!.status).toBe("cancelled");
    expect((await item.state())!.planningReview?.status).toBe("cancelled");
    await expect(item.run("recover")).rejects.toThrow("no recoverable review");
    await expect(item.run("review", { plan })).rejects.toThrow("user-requested /plan --revise");
    expect(item.calls()).toBe(1);
    await item.start("--revise User has supplied new feedback");
    expect((await item.state())!.status).toBe("draft");
    expect((await item.state())!.id).not.toBe(item.id);
  } finally { await item.cleanup(); }
});
