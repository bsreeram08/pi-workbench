import { recordResearchPage } from "../research-provenance.ts";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSupervisorAgents, selectSpecialists } from "../agents.ts";
import piWorkbench from "../index.ts";
import {
  getWorkflowAgentProfile,
  resolveWorkflowAgent,
  selectPlanningDiscoveryAgentIds,
  validateParallelWorkflowAgents,
} from "../workflow-agents.ts";
import { routeConcepts } from "../workflow-concepts.ts";
import {
  codeReviewsPass,
  parseExecutionBlockerVerdict,
  parseCodeVerdict,
  parsePlanningClearance,
  parsePlanVerdict,
  planReviewsPass,
  legacyVerificationPasses,
} from "../workflow-prompts.ts";
import {
  createWorkflowPlanId,
  getWorkflowPaths,
  loadCurrentWorkflowPlan,
  saveWorkflowPlan,
  type WorkflowPlanState,
} from "../workflow-state.ts";
import { AgentDashboardState } from "../dashboard-state.ts";
import { WorkbenchDashboardController } from "../dashboard-controller.ts";
import { AgentDetailOverlay } from "../agent-overlay.ts";
import { canDelegateSpecialists, parseSupervisorDecision } from "../supervisor.ts";
import { DEFAULT_CONFIG, normalizeConfig } from "../config.ts";
import { allowedQmdCollections, resolveQmdCollections } from "../project.ts";
import { SKILL_EVOLUTION_ENABLED_BY_DEFAULT } from "../skill-evolution.ts";
import {
  CHILD_MEMORY_ACTIONS,
  bashTouchesProtectedAgentStorage,
  createParentQuestionGuard,
  createToolCallBudgetGuard,
  projectPathBlocked,
} from "../child-tools.ts";
import { createResearchTracks, detectResearchMode, parseResearchAgentOutput } from "../research-prompts.ts";
import {
  auditResearchEvidence,
  createResearchRun,
  getResearchStatePaths,
  loadResearchRun,
  mergeEvidence,
  readEvidence,
  saveResearchRun,
  writeEvidence,
} from "../research-state.ts";
import { extractHtmlDocument, parseYahooSearchResults } from "../research-tools.ts";
import {
  appendDecision,
  assertCouncilAuthorityUnchanged,
  captureCouncilAuthority,
  CouncilAuthoritySnapshotMismatchError,
  ensureProjectState,
  formatQmdResults,
  getProjectPaths,
  loadSession,
  saveSession,
} from "../project.ts";
import {
  assertSafeForParallelWorktrees,
  cleanupWorkerWorkspaces,
  createWorkerWorkspaces,
  describeWorkspaceChanges,
} from "../worktrees.ts";
import type { CouncilSession, Exec } from "../types.ts";

describe("supervisor decision protocol", () => {
  test("accepts project-specific specialist names and maps recognizable roles", () => {
    const agents = resolveSupervisorAgents({
      roles: ["architecture-maintainability-reviewer", "advanced-routing-conformance-reviewer"],
    }, 6);
    expect(agents.map((agent) => agent.id)).toEqual(["architect", "qa"]);
  });

  test("treats review decisions with roles as valid delegation", () => {
    expect(canDelegateSpecialists({ action: "review", phase: "council", roles: ["qa"], rationale: "inspect the proposal" })).toBe(true);
    expect(canDelegateSpecialists({ action: "complete", phase: "council", roles: ["qa"], rationale: "done" })).toBe(false);
  });

  test("parses structured decisions and rejects malformed output", () => {
    expect(parseSupervisorDecision('<workbench-decision>{"action":"delegate","phase":"review","roles":["qa"],"rationale":"changed tests"}</workbench-decision>')).toEqual({
      action: "delegate",
      phase: "review",
      roles: ["qa"],
      rationale: "changed tests",
    });
    expect(parseSupervisorDecision("not structured")).toBeUndefined();
    expect(parseSupervisorDecision('<workbench-decision>{"action":"delegate","roles":[]}</workbench-decision>')).toBeUndefined();
  });
});

describe("agent dashboard state", () => {
  test("groups jobs, selects agents, and keeps finished history separate", () => {
    const dashboard = new AgentDashboardState();
    dashboard.beginRun("run-1");
    dashboard.addJob({ id: "ux", title: "UX Designer", groupId: "round-1", groupTitle: "Round 1" });
    dashboard.addJob({ id: "qa", title: "Quality Engineer", groupId: "round-1", groupTitle: "Round 1" });

    expect(dashboard.getActiveGroups()).toHaveLength(1);
    dashboard.updateJob("ux", { status: "running", latestActivity: "Inspecting changes" });
    dashboard.finishJob("ux", "completed", { output: "done" });

    expect(dashboard.finishedCount).toBe(1);
    expect(dashboard.getFinishedGroups()[0]?.jobs[0]?.output).toBe("done");
    dashboard.selectJob("qa");
    expect(dashboard.getSelectedJob()?.title).toBe("Quality Engineer");
  });

  test("clears the previous run and silently ignores invalid controls", () => {
    const dashboard = new AgentDashboardState();
    dashboard.beginRun("run-1");
    dashboard.addJob({ id: "one", title: "One", groupId: "phase", groupTitle: "Phase" });
    dashboard.selectJob("missing");
    dashboard.toggleGroup("missing");
    dashboard.toggleTool("one", "missing");
    dashboard.beginRun("run-2");

    expect(dashboard.currentRunId).toBe("run-2");
    expect(dashboard.getGroups()).toHaveLength(0);
  });

  test("uses Ctrl+Alt+A as a single dashboard focus toggle", () => {
    const controller = new WorkbenchDashboardController({} as any);
    let input: ((data: string) => any) | undefined;
    controller.attach({
      mode: "tui",
      ui: {
        onTerminalInput(handler: (data: string) => any) { input = handler; return () => undefined; },
        setFooter() {},
      },
    } as any);
    expect(controller.state.isFocused()).toBe(false);
    controller.toggleFocus();
    expect(controller.state.isFocused()).toBe(true);
    controller.toggleFocus();
    expect(controller.state.isFocused()).toBe(false);
    expect(input?.("unbound")).toBeUndefined();
    controller.dispose();
  });

  test("keeps selected-child cancellation local and aborts the run before cancel-all children", () => {
    const controller = new WorkbenchDashboardController({} as any);
    let input: ((data: string) => unknown) | undefined;
    controller.attach({
      mode: "tui",
      ui: {
        onTerminalInput(handler: (data: string) => unknown) { input = handler; return () => undefined; },
        setFooter() {},
      },
    } as any);
    const runController = new AbortController();
    const events: string[] = [];
    runController.signal.addEventListener("abort", () => events.push("run"));
    controller.beginRun("run-1", runController);
    controller.addJob("one", "One", "phase", "Phase");
    controller.setControl("one", {
      steer() {}, pause() {}, resume() {}, restart() {}, cancel() { events.push("child"); },
    });
    controller.focusCards();

    input?.("c");
    expect(runController.signal.aborted).toBe(false);
    expect(events).toEqual(["child"]);
    events.length = 0;
    input?.("C");
    expect(runController.signal.aborted).toBe(true);
    expect(events).toEqual(["run", "child"]);
    controller.dispose();
  });

  test("routes overlay cancel-all through the run controller before child cancellation", () => {
    const controller = new WorkbenchDashboardController({} as any);
    const runController = new AbortController();
    const events: string[] = [];
    runController.signal.addEventListener("abort", () => events.push("run"));
    controller.beginRun("overlay-run", runController);
    controller.addJob("overlay-job", "Overlay Job", "phase", "Phase");
    controller.setControl("overlay-job", {
      steer() {}, pause() {}, resume() {}, restart() {}, cancel() { events.push("child"); },
    });
    const overlay = new AgentDetailOverlay(
      { showOverlay: () => ({ hide() {} }) } as any,
      {} as any,
      controller.state,
      "overlay-job",
      { cancelRun: () => controller.cancelRun(), copy() {}, requestRender() {} },
      () => undefined,
    );

    overlay.handleInput("C");
    expect(events).toEqual(["run", "child"]);
    controller.dispose();
  });
});

describe("dynamic specialist selection", () => {
  test("always includes intent, opposition, and knowledge perspectives", () => {
    const ids = selectSpecialists("rename one button", 4).map((agent) => agent.id);
    expect(ids).toContain("product");
    expect(ids).toContain("opponent");
    expect(ids).toContain("researcher");
  });

  test("selects domain specialists from the topic", () => {
    const ids = selectSpecialists("Design authentication UI and threat model user tokens", 7).map((agent) => agent.id);
    expect(ids).toContain("security");
    expect(ids).toContain("ux");
  });

});

describe("Pi workflow routing", () => {
  test("exposes reviewed consolidation proposals to specialist child agents", () => {
    expect(CHILD_MEMORY_ACTIONS).toContain("propose_consolidation");
  });

  test("allows at most one parent question per child process", () => {
    const consume = createParentQuestionGuard();
    expect(consume()).toBe(true);
    expect(consume()).toBe(false);
    expect(consume()).toBe(false);
  });

  test("hard-blocks Workbench child tools after the configured read-only limit", () => {
    const consume = createToolCallBudgetGuard("2");
    expect(consume()).toBe(true);
    expect(consume()).toBe(true);
    expect(consume()).toBe(false);
    expect(consume()).toBe(false);
    expect(createToolCallBudgetGuard("")()).toBe(true);
  });

  test("confines child file tools to the delegated project and protects Pi storage from Bash", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "child-project-scope-")));
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    const agentDir = path.join(root, ".pi", "agent");
    await fs.mkdir(project);
    await fs.mkdir(outside);
    await fs.mkdir(agentDir, { recursive: true });
    await fs.symlink(outside, path.join(project, "escape"));
    const previous = process.env.PI_WORKBENCH_PROJECT_ROOT;
    process.env.PI_WORKBENCH_PROJECT_ROOT = project;
    try {
      expect(projectPathBlocked(project, "inside.ts", false)).toBe(false);
      expect(projectPathBlocked(project, outside, false)).toBe(true);
      expect(projectPathBlocked(project, "escape/secret", false)).toBe(true);
      expect(projectPathBlocked(project, undefined, true)).toBe(false);
      expect(bashTouchesProtectedAgentStorage(`cat ${path.join(agentDir, "auth.json")}`, agentDir)).toBe(true);
      expect(bashTouchesProtectedAgentStorage("cat $PI_CODING_AGENT_DIR/auth.json", agentDir)).toBe(true);
      expect(bashTouchesProtectedAgentStorage("git diff -- src/index.ts", agentDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PI_WORKBENCH_PROJECT_ROOT;
      else process.env.PI_WORKBENCH_PROJECT_ROOT = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("constrains QMD search to the two project collections", () => {
    const allowed = allowedQmdCollections({
      stateCollection: "pi-workbench-state-abc",
      projectCollection: "pi-workbench-project-abc",
    });
    expect(allowed).toEqual(["pi-workbench-state-abc", "pi-workbench-project-abc"]);
    expect(resolveQmdCollections(undefined, allowed)).toEqual({ ok: true, collections: allowed });
    expect(resolveQmdCollections("pi-workbench-project-abc", allowed)).toEqual({
      ok: true, collections: ["pi-workbench-project-abc"],
    });
    expect(resolveQmdCollections("secrets", allowed).ok).toBe(false);
    expect(resolveQmdCollections("any", []).ok).toBe(false);
  });

  test("routes workflow agents from task effort rather than fixed role assignments", () => {
    expect(resolveWorkflowAgent("codebase-explorer", DEFAULT_CONFIG, "Find one symbol.")?.model).toBe("openai-codex/gpt-5.6-luna:low");
    expect(resolveWorkflowAgent("codebase-explorer", DEFAULT_CONFIG, "Investigate a hard cross-cutting concurrency root cause across services.")?.model).toBe("openai-codex/gpt-5.6-sol:high");
    expect(resolveWorkflowAgent("planner", DEFAULT_CONFIG, "Draft a bounded local rename plan.", "light")?.model).toBe("openai-codex/gpt-5.6-luna:low");
    expect(resolveWorkflowAgent("planner", { ...DEFAULT_CONFIG, fastMode: false })?.fastMode).toBe(false);
    expect(getWorkflowAgentProfile("task implementer")?.id).toBe("task-implementer");
  });

  test("adds Researcher only when external knowledge can change the plan", () => {
    expect(selectPlanningDiscoveryAgentIds("Rename a local variable")).toEqual(["codebase-explorer"]);
    expect(selectPlanningDiscoveryAgentIds("Integrate the latest SDK documentation")).toEqual(["codebase-explorer", "researcher"]);
  });

  test("composes engineering, design, and experimentation concepts contextually", () => {
    const ui = routeConcepts("Optimize the modal animation latency", "implementer");
    expect(ui.packs).toContain("engineering");
    expect(ui.packs).toContain("design");
    expect(ui.packs).toContain("experimentation");
    expect(ui.skills).toContain("tdd");
    expect(ui.skills).toContain("animate");
    expect(ui.skills).toContain("autoresearch-create");

    const local = routeConcepts("Rename a server constant", "codebase-explorer");
    expect(local.packs).toEqual(["engineering"]);
    expect(local.skills).not.toContain("emil-design-eng");
  });

  test("requires one strict terminal plan and code verdict marker", () => {
    expect(parsePlanningClearance('<clearance>{"ready":false,"questions":["Which API?"],"assumptions":[]}</clearance>')).toEqual({
      ready: false,
      questions: ["Which API?"],
      assumptions: [],
    });
    expect(parsePlanVerdict("looks fine")).toBe("REJECT");
    expect(parsePlanVerdict("review prose\n<plan-verdict>OKAY</plan-verdict>\n")).toBe("OKAY");
    expect(parsePlanVerdict("<plan-verdict>OKAY</plan-verdict>\ntrailing prose")).toBe("REJECT");
    expect(parsePlanVerdict("<plan-verdict>REJECT</plan-verdict>\n<plan-verdict>OKAY</plan-verdict>")).toBe("REJECT");
    expect(parsePlanVerdict("<plan-verdict>okay</plan-verdict>")).toBe("REJECT");
    expect(parsePlanVerdict("<plan-verdict>unknown</plan-verdict>\n<plan-verdict>OKAY</plan-verdict>")).toBe("REJECT");
    expect(parseCodeVerdict("missing marker")).toBe("CHANGES_REQUIRED");
    expect(parseCodeVerdict("review prose\n<code-verdict>BLOCKED</code-verdict>\n")).toBe("BLOCKED");
    expect(parseCodeVerdict("<code-verdict>PASS</code-verdict>\ntrailing prose")).toBe("CHANGES_REQUIRED");
    expect(parseCodeVerdict("<code-verdict>BLOCKED</code-verdict>\n<code-verdict>PASS</code-verdict>")).toBe("CHANGES_REQUIRED");
    expect(parseCodeVerdict("<code-verdict>pass</code-verdict>")).toBe("CHANGES_REQUIRED");
    expect(parseCodeVerdict("<code-verdict>unknown</code-verdict>\n<code-verdict>PASS</code-verdict>")).toBe("CHANGES_REQUIRED");
    expect(legacyVerificationPasses("done <verified/>")).toBe(true);
    expect(legacyVerificationPasses("<verified/> but also <failed/>")).toBe(false);
    expect(parseExecutionBlockerVerdict("## Blockers\n- None.\n")).toBe("clear");
    expect(parseExecutionBlockerVerdict("## Blockers\n- Missing migration rollback.\n")).toBe("blocked");
    expect(parseExecutionBlockerVerdict("No section")).toBe("invalid");
    expect(parseExecutionBlockerVerdict("## Blockers\n\n## Next\nText")).toBe("invalid");
    expect(parseExecutionBlockerVerdict("## Blockers\nNone\n## Blockers\nNone")).toBe("invalid");
  });

  test("requires two independent passing reviewers and serializes writers", () => {
    const passing = [
      { agentId: "quality-reviewer", title: "Quality Reviewer", output: "<plan-verdict>OKAY</plan-verdict>", exitCode: 0 },
      { agentId: "technical-reviewer", title: "Technical Reviewer", output: "<plan-verdict>OKAY</plan-verdict>", exitCode: 0 },
    ];
    expect(planReviewsPass(passing)).toBe(true);
    expect(planReviewsPass(passing.slice(0, 1))).toBe(false);
    const passingCode = "<workflow-findings>{\"schemaVersion\":1,\"findings\":[]}</workflow-findings>\n<code-verdict>PASS</code-verdict>";
    expect(codeReviewsPass(passing.map((item) => ({ ...item, output: "<code-verdict>PASS</code-verdict>" })))).toBe(false);
    expect(codeReviewsPass(passing.map((item) => ({ ...item, output: passingCode })))).toBe(true);

    const readers = [resolveWorkflowAgent("quality-reviewer", DEFAULT_CONFIG)!, resolveWorkflowAgent("technical-reviewer", DEFAULT_CONFIG)!];
    expect(validateParallelWorkflowAgents(readers)).toBeUndefined();
    expect(validateParallelWorkflowAgents([resolveWorkflowAgent("implementer", DEFAULT_CONFIG)!])).toContain("read-only only");
  });

  test("persists the current reviewed plan and stable artifact id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-state-test-"));
    try {
      const paths = getWorkflowPaths(root);
      const id = createWorkflowPlanId("Build a polished UI", new Date("2026-08-18T00:00:00.000Z"));
      expect(id).toBe("2026-08-18T00-00-00-000Z-build-a-polished-ui");
      const state: WorkflowPlanState = {
        version: 1,
        id,
        task: "Build a polished UI",
        status: "approved",
        plan: "# Plan\n\n1. Implement it.",
        interviewNotes: "Use the existing design system.",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        reviewRounds: 1,
        planPath: "",
      };
      await saveWorkflowPlan(paths, state);
      expect((await loadCurrentWorkflowPlan(paths))?.status).toBe("approved");
      expect(await fs.readFile(state.planPath, "utf8")).toContain("> Status: approved");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("project settings", () => {
  test("keeps network skill evolution opt-in without explicit configuration", () => {
    expect(SKILL_EVOLUTION_ENABLED_BY_DEFAULT).toBe(false);
  });

  test("normalizes unsafe and invalid values", () => {
    expect(normalizeConfig({
      maxCouncilAgents: 100,
      parallelImplementationWorkers: 0,
      maxFixLoops: -5,
      defaultImplementationSession: "invalid",
      qmdEnabled: "yes",
      fastMode: "yes",
    })).toEqual({
      workflowMode: "focused",
      maxCouncilAgents: 8,
      parallelImplementationWorkers: 1,
      maxFixLoops: 1,
      defaultImplementationSession: "ask",
      qmdEnabled: true,
      fastMode: true,
      maxResearchAgents: 5,
      researchSourcesPerTrack: 6,
      researchOutputDir: "research",
      researchDefaultDepth: "decision-grade",
      researchRequirePlanConfirmation: true,
      researchWorkerModel: "openai-codex/gpt-5.4-mini:medium",
      researchSynthesisModel: "openai-codex/gpt-5.6-sol:high",
      researchAuditModel: "openai-codex/gpt-5.4:high",
      workflowMaxParallelAgents: 4,
      workflowMaxInterviewRounds: 2,
      workflowMaxPlanReviewLoops: 3,
      workflowMaxFixLoops: 3,
      workflowFastModel: "openai-codex/gpt-5.4-mini:medium",
      workflowPlanningModel: "openai-codex/gpt-5.6-sol:high",
      workflowDeepModel: "openai-codex/gpt-5.6-sol:medium",
      workflowReviewModel: "openai-codex/gpt-5.6-terra:high",
      modelRoutingPolicy: "balanced",
      modelRoutingFamily: "grok",
    });
  });

  test("defaults fast mode on, persists explicit false, and rejects invalid values", () => {
    expect(normalizeConfig({}).fastMode).toBe(true);
    expect(normalizeConfig({ fastMode: false }).fastMode).toBe(false);
    expect(normalizeConfig({ fastMode: "false" }).fastMode).toBe(true);
  });

  test("uses opinionated defaults for missing values", () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });
});

interface CouncilCommandHarness {
  readonly commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  readonly reports: Array<{ title: string; body: string }>;
}

function councilCommandHarness(root: string): CouncilCommandHarness {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  const reports: Array<{ title: string; body: string }> = [];
  const pi = {
    registerCommand(name: string, command: any) { commands.set(name, command.handler); },
    registerEntryRenderer() {},
    registerShortcut() {},
    registerTool() {},
    on() {},
    appendEntry(_type: string, data: { title?: string; body?: string }) {
      if (data.title && data.body) reports.push({ title: data.title, body: data.body });
    },
    events: { on() {}, emit() {} },
    exec: async (_command: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
      if (args.includes("--porcelain")) return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  } as any;
  piWorkbench(pi);
  return { commands, reports };
}

describe("durable project state", () => {
  test("rejects a symlinked .pi directory without creating external state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-state-link-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-state-external-"));
    try {
      await fs.symlink(external, path.join(root, ".pi"), "dir");
      await expect(ensureProjectState(getProjectPaths(root))).rejects.toThrow("Unsafe project state directory");
      expect(await fs.readdir(external)).toEqual([]);
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(external, { recursive: true, force: true }),
      ]);
    }
  });

  test("does not follow a symlinked decision destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-decision-link-"));
    const external = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-decision-external-")), "outside.md");
    try {
      const paths = getProjectPaths(root);
      await fs.mkdir(paths.stateDir, { recursive: true });
      await fs.writeFile(external, "outside\n");
      await fs.symlink(external, paths.decisions);
      await expect(ensureProjectState(paths)).rejects.toThrow("Unsafe project decision file");
      expect(await fs.readFile(external, "utf8")).toBe("outside\n");
    } finally {
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(path.dirname(external), { recursive: true, force: true }),
      ]);
    }
  });

  test("creates decision storage and round-trips a session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-test-"));
    try {
      const paths = getProjectPaths(root);
      await ensureProjectState(paths);
      await appendDecision(paths, "## User decision\n\nUse SQLite because it is local-first.");
      const session: CouncilSession = {
        version: 1,
        projectRoot: root,
        topic: "Build a local app",
        phase: "intent-approved",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["product", "opponent"],
        rounds: [],
      };
      await saveSession(paths, session);
      expect(await loadSession(paths)).toEqual(session);
      expect(await fs.readFile(paths.decisions, "utf8")).toContain("Use SQLite because it is local-first");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects changed council authority without mutating the replacement session or intent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-authority-test-"));
    const paths = getProjectPaths(root);
    try {
      await ensureProjectState(paths);
      const original: CouncilSession = {
        version: 1,
        projectRoot: root,
        topic: "Original approved intent",
        phase: "intent-approved",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["product"],
        rounds: [],
      };
      await saveSession(paths, original);
      await fs.writeFile(paths.intent, "> Status: Approved\n\nOriginal.\n", "utf8");
      const snapshot = await captureCouncilAuthority(paths);

      const replacement = { ...original, topic: "Replacement authority", updatedAt: "2026-01-02T00:00:00.000Z" };
      await saveSession(paths, replacement);
      await fs.writeFile(paths.intent, "> Status: Approved\n\nReplacement.\n", "utf8");
      const sessionBeforeGuard = await fs.readFile(paths.session, "utf8");
      const intentBeforeGuard = await fs.readFile(paths.intent, "utf8");

      await expect(assertCouncilAuthorityUnchanged(paths, snapshot)).rejects.toBeInstanceOf(CouncilAuthoritySnapshotMismatchError);
      expect(await fs.readFile(paths.session, "utf8")).toBe(sessionBeforeGuard);
      expect(await fs.readFile(paths.intent, "utf8")).toBe(intentBeforeGuard);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("blocks council subagents until the project is trusted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-untrusted-"));
    try {
      const commandHarness = councilCommandHarness(root);
      const notices: string[] = [];
      const expected = "This project is not trusted. Project .pi resources and packages are ignored. Use /trust to save a trust decision, then restart pi.";
      await commandHarness.commands.get("council")?.("Investigate this project", {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => false,
        ui: { notify(message: string) { notices.push(message); } },
      } as any);
      expect(notices).toEqual([expected]);
      expect(commandHarness.reports.at(-1)).toEqual({ title: "Project trust required", body: expected });
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("council implementation mismatch launches neither workers nor a new session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-council-command-"));
    const isolatedAgentDir = path.join(await fs.realpath(root), ".isolated-agent");
    await fs.mkdir(isolatedAgentDir, { recursive: true });
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = await fs.realpath(isolatedAgentDir);
    const paths = getProjectPaths(root);
    const original: CouncilSession = {
      version: 1,
      projectRoot: root,
      topic: "Confirmed authority",
      phase: "intent-approved",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: ["product"],
      rounds: [],
    };
    try {
      await ensureProjectState(paths);
      await saveSession(paths, original);
      await fs.writeFile(paths.intent, "> Status: Approved\n\nConfirmed.\n", "utf8");
      const sameHarness = councilCommandHarness(root);
      let newSessions = 0;
      const replacement = { ...original, topic: "Replacement authority", updatedAt: "2026-01-02T00:00:00.000Z" };
      const ctx = {
        cwd: root,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
          confirm: async () => {
            await saveSession(paths, replacement);
            await fs.writeFile(paths.intent, "> Status: Approved\n\nReplacement.\n", "utf8");
            return true;
          },
          setStatus() {},
        },
        newSession: async () => { newSessions++; },
      } as any;
      await sameHarness.commands.get("council-implement")?.("same", ctx);
      expect((await loadSession(paths))?.topic).toBe("Replacement authority");
      expect(await fs.readFile(paths.intent, "utf8")).toContain("Replacement.");
      expect(await fs.readdir(paths.stateDir)).not.toContain("ImplementationPlan.md");
      expect(newSessions).toBe(0);
      expect(sameHarness.reports.at(-1)?.body).toContain("rerun");
      expect(sameHarness.reports.at(-1)?.body).toContain("reconfirm");

      await saveSession(paths, original);
      await fs.writeFile(paths.intent, "> Status: Approved\n\nConfirmed.\n", "utf8");
      const newHarness = councilCommandHarness(root);
      const newCtx = {
        ...ctx,
        ui: {
          select: async () => {
            await saveSession(paths, replacement);
            return "New session (recommended)";
          },
          setStatus() {},
        },
      } as any;
      await newHarness.commands.get("council-implement")?.("", newCtx);
      expect(newSessions).toBe(0);
      expect((await loadSession(paths))?.topic).toBe("Replacement authority");
      expect(newHarness.reports.at(-1)?.body).toContain("rerun");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("force-complete mismatch preserves the replacement council session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-force-command-"));
    const paths = getProjectPaths(root);
    const original: CouncilSession = {
      version: 1,
      projectRoot: root,
      topic: "Confirmed authority",
      phase: "implementing",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: ["product"],
      rounds: [],
    };
    try {
      await ensureProjectState(paths);
      await saveSession(paths, original);
      await fs.writeFile(paths.intent, "> Status: Approved\n\nConfirmed.\n", "utf8");
      const commandHarness = councilCommandHarness(root);
      const replacement = { ...original, topic: "Replacement authority", updatedAt: "2026-01-02T00:00:00.000Z" };
      await commandHarness.commands.get("council-force-complete")?.("accept risk", {
        cwd: root,
        hasUI: true,
        ui: {
          confirm: async () => { await saveSession(paths, replacement); return true; },
          setStatus() {},
        },
      } as any);

      expect(await loadSession(paths)).toEqual(replacement);
      expect(await fs.readFile(paths.decisions, "utf8")).not.toContain("User forced completion");
      expect(commandHarness.reports.at(-1)?.body).toContain("rerun");
      expect(commandHarness.reports.at(-1)?.body).toContain("reconfirm");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("formats QMD evidence with paths and scores", () => {
    const output = formatQmdResults([{ file: "qmd://project/Intent.md", score: 0.88, snippet: "Approved intent" }]);
    expect(output).toContain("qmd://project/Intent.md");
    expect(output).toContain("0.88");
    expect(output).toContain("Approved intent");
  });
});

describe("research planning and evidence", () => {
  test("selects bounded profile-specific tracks", () => {
    expect(detectResearchMode("Find current commercial rent and competitors")).toBe("market");
    expect(detectResearchMode("Compare competitor pricing and customer demand")).toBe("market");
    expect(detectResearchMode("Check the official SDK specification and API versions")).toBe("technical");
    expect(detectResearchMode("What is the current Node.js LTS release?")).toBe("technical");
    expect(detectResearchMode("As of 2026-09-03, map public user demand and scoped package names in the Pi coding-agent ecosystem")).toBe("technical");
    expect(detectResearchMode("Should we open a cafe near the catchment and commercial property listings?")).toBe("market");
    expect(detectResearchMode("What is the smallest valuable workflow product?")).toBe("general");
    expect(createResearchTracks("market", "fast", 6)).toHaveLength(3);
    expect(createResearchTracks("technical", "decision-grade", 4)).toHaveLength(4);
    expect(createResearchTracks("market", "decision-grade", 6).map((track) => track.id)).toContain("skeptic-gaps");
  });

  test("parses structured agent output and rejects malformed evidence JSON", () => {
    const parsed = parseResearchAgentOutput(`=== FINDINGS ===\nA finding.\n=== EVIDENCE JSON ===\n[{"claim":"A claim","sourceUrl":"https://example.com"}]\n=== OPEN QUESTIONS ===\nCall to verify.`);
    expect(parsed.findings).toBe("A finding.");
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.openQuestions).toBe("Call to verify.");

    const malformed = parseResearchAgentOutput(`=== FINDINGS ===\nA\n=== EVIDENCE JSON ===\nnot-json\n=== OPEN QUESTIONS ===\nB`);
    expect(malformed.evidence).toHaveLength(0);
    expect(malformed.parseWarning).toContain("could not be parsed");
  });

  test("extracts page metadata and Yahoo discovery results", () => {
    const page = extractHtmlDocument(`<html><head><title>Official Price</title><meta property="og:site_name" content="Example Inc"><meta name="description" content="Current plan"><link rel="canonical" href="https://example.com/price"></head><body><nav>Menu</nav><h1>Plan</h1><p>₹99 per hour</p><script>ignore()</script></body></html>`);
    expect(page.title).toBe("Official Price");
    expect(page.publisher).toBe("Example Inc");
    expect(page.text).toContain("₹99 per hour");
    expect(page.text).not.toContain("ignore");

    const yahoo = parseYahooSearchResults(`<div class="dd algo"><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=x/RU=https%3A%2F%2Fexample.com%2Fprice/RK=2/RS=x"><h3><span>Example price</span></h3></a></div><div class="compText"><p>₹99 per hour</p></div></div></li>`);
    expect(yahoo).toEqual([{ title: "Example price", url: "https://example.com/price", snippet: "₹99 per hour" }]);
  });

  test("persists a run and audits source-backed numeric claims", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-research-test-"));
    try {
      const councilState = path.join(root, ".pi", "pi-workbench");
      const tracks = createResearchTracks("market", "fast", 3);
      tracks.forEach((track) => { track.status = "complete"; });
      const run = await createResearchRun(root, councilState, { ...DEFAULT_CONFIG, researchOutputDir: "research" }, {
        question: "What is the current price?",
        decision: "Choose a test price",
        mode: "market",
        depth: "fast",
        geography: "Test City",
        asOf: "2026-08-17",
        tracks,
        providerSummary: ["test"],
      });
      const fetchedPage = { requestedUrl: "https://example.com/price", finalUrl: "https://example.com/price", title: "Official price", text: "₹99 per hour", contentHash: "1".repeat(64), retrievedAt: "2026-08-17T00:00:00.000Z", contentType: "text/html", truncated: false };
      const sources = new Map([[fetchedPage.requestedUrl, await recordResearchPage(root, run, fetchedPage)]]);
      let evidence = mergeEvidence([], [{
        claim: "The official rate is ₹99 per hour.",
        kind: "fact",
        sourceTier: "official",
        confidence: "high",
        verificationStatus: "web-retrieved",
        sourceUrl: "https://example.com/price?utm_source=test",
        sourceTitle: "Official price",
        retrievedAt: "2026-08-17T00:00:00.000Z",
        excerpt: "₹99 per hour",
        volatile: true,
      }], run, "competition-pricing", { sources });
      await writeEvidence(root, run, evidence);
      run.status = "complete";
      await saveResearchRun(councilState, run);

      const restored = await loadResearchRun(councilState);
      expect(restored?.id).toBe(run.id);
      expect(getResearchStatePaths(councilState).current).toContain("research/current.json");
      evidence = await readEvidence(root, run);
      expect(evidence[0]?.canonicalUrl).toBe("https://example.com/price");
      const audit = auditResearchEvidence(run, evidence, "The current rate is ₹99 per hour [E-001].");
      expect(audit.status).toBe("pass");

      const broken = auditResearchEvidence(run, [{ ...evidence[0], sourceUrl: undefined, canonicalUrl: undefined }], "The rate is ₹99 [E-001].");
      expect(broken.status).toBe("fail");
      expect(broken.issues.map((issue) => issue.code)).toContain("MISSING_SOURCE");

      evidence[0].verificationStatus = "needs-review";
      evidence[0].contentHash = "old-hash";
      sources.set(fetchedPage.requestedUrl, await recordResearchPage(root, run, { ...fetchedPage, text: "Updated ₹99 per hour", contentHash: "2".repeat(64), retrievedAt: "2026-08-18T00:00:00.000Z" }));
      const reviewed = mergeEvidence(evidence, [{
        claim: evidence[0].claim,
        sourceUrl: evidence[0].sourceUrl,
        sourceTier: "official",
        kind: "fact",
        confidence: "high",
        verificationStatus: "web-retrieved",
        retrievedAt: "2026-08-18T00:00:00.000Z",
        excerpt: "Updated ₹99 per hour",
        contentHash: "new-hash",
      }], run, "manual-source", { sources });
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0].contentHash).toBe("2".repeat(64));
      expect(reviewed[0].verificationStatus).toBe("web-retrieved");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes unsafe research settings", () => {
    const config = normalizeConfig({
      maxResearchAgents: 99,
      researchSourcesPerTrack: 1,
      researchOutputDir: "../../outside",
      researchDefaultDepth: "unknown",
      researchRequirePlanConfirmation: false,
      researchWorkerModel: "  fast-model  ",
    });
    expect(config.maxResearchAgents).toBe(6);
    expect(config.researchSourcesPerTrack).toBe(3);
    expect(config.researchOutputDir).toBe("research");
    expect(config.researchDefaultDepth).toBe("decision-grade");
    expect(config.researchRequirePlanConfirmation).toBe(false);
    expect(config.researchWorkerModel).toBe("fast-model");
  });
});

describe("parallel worktree safety", () => {
  test("creates isolated workers, exposes their changes, and cleans them up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-git-test-"));
    const actualExec: Exec = async (command, args, options) => {
      const process = Bun.spawn([command, ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = options?.timeout
        ? setTimeout(() => process.kill(), options.timeout)
        : undefined;
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (timeout) clearTimeout(timeout);
      return { stdout, stderr, code };
    };

    try {
      await actualExec("git", ["init", "-q"]);
      await fs.writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
      await actualExec("git", ["add", "README.md"]);
      await actualExec("git", ["-c", "user.name=Workbench Test", "-c", "user.email=workbench@example.test", "commit", "-qm", "initial"]);

      await assertSafeForParallelWorktrees(root, actualExec);
      const group = await createWorkerWorkspaces(root, ["developer", "qa"], actualExec);
      expect(group.workers).toHaveLength(2);
      expect(group.workers[0].path).not.toBe(group.workers[1].path);
      await fs.writeFile(path.join(group.workers[0].path, "README.md"), "# Worker change\n", "utf8");
      expect(await describeWorkspaceChanges(group.workers[0], actualExec)).toContain("README.md");
      await cleanupWorkerWorkspaces(root, group, actualExec);
      const listing = await actualExec("git", ["worktree", "list", "--porcelain"]);
      expect(listing.stdout).not.toContain(group.root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("allows council metadata but blocks dirty source files", async () => {
    const cleanExec: Exec = async (_command, args) => {
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0 };
      return { stdout: "?? .pi/pi-workbench/Intent.md\n", stderr: "", code: 0 };
    };
    await expect(assertSafeForParallelWorktrees("/repo", cleanExec)).resolves.toBeUndefined();

    const dirtyExec: Exec = async (_command, args) => {
      if (args.includes("--show-toplevel")) return { stdout: "/repo\n", stderr: "", code: 0 };
      return { stdout: " M src/app.ts\n?? .pi/pi-workbench/Intent.md\n", stderr: "", code: 0 };
    };
    await expect(assertSafeForParallelWorktrees("/repo", dirtyExec)).rejects.toThrow("src/app.ts");
  });
});
