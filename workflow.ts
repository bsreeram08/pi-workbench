import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  WORKFLOW_AGENT_IDS,
  formatWorkflowRoster,
  getWorkflowAgentProfile,
  resolveWorkflowAgent,
  requireAvailableDelegationModel,
  selectPlanningDiscoveryAgentIds,
  validateParallelWorkflowAgents,
  type WorkflowAgentId,
  type WorkflowAgentProfile,
} from "./workflow-agents.ts";
import {
  parseExecutionBlockerVerdict,
  buildExecutionBriefTask,
  buildClearanceTask,
  buildCodeReviewTask,
  buildWorkflowSystemPrompt,
  buildDiscoveryTask,
  buildFixTask,
  buildImplementationTask,
  buildIndependentVerificationTask,
  buildPacketVerificationTask,
  buildRequirementsAnalysisTask,
  buildPlanReviewTask,
  buildPlanRevisionTask,
  buildPlannerTask,
  codeReviewsPass,
  inspectPlanningClearance,
  planReviewsPass,
  legacyVerificationPasses,
  type PlanningClearance,
} from "./workflow-prompts.ts";
import {
  assertWorkflowAuthorityUnchanged,
  captureWorkflowAuthority,
  createWorkflowPlanId,
  formatWorkflowPlanStatus,
  getWorkflowPaths,
  loadCurrentWorkflowPlan,
  saveWorkflowPlan,
  WorkflowStateSnapshotMismatchError,
  writeWorkflowRunArtifact,
  type WorkflowPlanState,
} from "./workflow-state.ts";
import {
  bindWorkflowTaskPacket,
  evaluateWorkflowVerification,
  formatWorkflowVerificationFailures,
  packetVerificationPasses,
  type WorkflowPacketVerification,
  type WorkflowTaskPacket,
} from "./workflow-task-packet.ts";
import { loadConfig, type WorkbenchConfig } from "./config.ts";
import type { WorkbenchDashboardController } from "./dashboard-controller.ts";
import { ensureProjectState, findProjectRoot, getProjectPaths } from "./project.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { getCommunityKnowledgePath } from "./skill-evolution.ts";
import { runSingleAgent } from "./subagents.ts";
import {
  assertMandatoryAgentBatch,
  assertMandatoryAgentResult,
  isWorkflowCancellation,
  throwIfWorkflowCancelled,
} from "./agent-result-guard.ts";
import { withExclusiveLease } from "./exclusive-lease.ts";
import { createWorkflowLifecycleEvent, WORKFLOW_LIFECYCLE_EVENT, type WorkflowLifecycleErrorCode, type WorkflowLifecyclePhase } from "./workflow-lifecycle.ts";
import { MODEL_ROUTING_RECEIPT_ENTRY } from "./model-routing.ts";
import type { AgentResult, Exec } from "./types.ts";
import { checkPassed } from "./verification.ts";
import { registerCoordinatorPlanning } from "./coordinator-planning.ts";
import { registerCoordinatorExecution } from "./coordinator-execution.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import { formatAgentResults } from "./prompts.ts";
import {
  formatRoutingReceipt,
  readOnlyBudgetGuidance,
  routeTask,
  type ModelRoute,
  type ModelRoutingState,
  type RoutingEffort,
} from "./routing.ts";

interface WorkflowDependencies {
  exec: Exec;
  dashboard: WorkbenchDashboardController;
  reprompterPath: string;
  report(title: string, body: string): void;
  getRoutingState(): ModelRoutingState;
  runAgent?: typeof runSingleAgent;
  withLease?: typeof withExclusiveLease;
}

type WorkbenchTaskState = "running" | "blocked" | "needs_attention" | "completed" | "failed" | "cancelled" | "interrupted";
type WorkbenchTaskScope = "plan" | "execution" | "autopilot" | "delegate";

interface Progress {
  update(message: string): void;
  pause(): void;
  finish(state: Exclude<WorkbenchTaskState, "running">, detail: string): void;
  clear(): void;
}

interface PlanningResult {
  state?: WorkflowPlanState;
  cancelled: boolean;
  executable: boolean;
}

interface DelegationToolDetails {
  mode: "single" | "parallel";
  results: AgentResult[];
  routes: Array<{ role: WorkflowAgentId; receipt: string; route: ModelRoute }>;
  blocked?: string;
}

const RoutingEffortSchema = StringEnum(["auto", "light", "standard", "heavy"] as const, {
  description: "Parent-judged effort. auto uses the conservative deterministic classifier.",
});

const TaskItemSchema = Type.Object({
  agent: StringEnum(WORKFLOW_AGENT_IDS, { description: "Specialized workflow agent" }),
  task: Type.String({ description: "Focused task with expected output and success criteria" }),
  effort: Type.Optional(RoutingEffortSchema),
  model: Type.Optional(Type.String({ description: "Exact provider/model[:thinking] for this lane; overrides routing without fallback" })),
});

function now(): string {
  return new Date().toISOString();
}

function progressFor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  title: string,
  task: string,
  scope: WorkbenchTaskScope,
  emitEvents = true,
): Progress {
  let activity: ReturnType<typeof startWorkflowActivity> | undefined = startWorkflowActivity(ctx, `${title}: starting`);
  const phase: WorkflowLifecyclePhase = scope === "plan" ? "planning" : scope === "delegate" ? "delegation" : "execution";
  let terminal = false;
  const emit = (state: WorkbenchTaskState): void => {
    if (!emitEvents) return;
    const errorCode: WorkflowLifecycleErrorCode | undefined = state === "cancelled"
      ? "cancelled"
      : state === "interrupted" || state === "failed"
        ? "operational_failure"
        : undefined;
    pi.events.emit(WORKFLOW_LIFECYCLE_EVENT, createWorkflowLifecycleEvent(phase, state, errorCode));
  };
  return {
    update(message) {
      if (!activity) activity = startWorkflowActivity(ctx, `${title}: ${message}`);
      else activity.update(`${title}: ${message}`);
      if (ctx.hasUI) ctx.ui.setStatus("workflow", `${title}: ${message}`);
      emit("running");
    },
    pause() { activity?.stop(); activity = undefined; },
    finish(state, _detail) {
      if (terminal) return;
      terminal = true;
      activity?.stop();
      emit(state);
    },
    clear() {
      activity?.stop();
      if (ctx.hasUI) ctx.ui.setStatus("workflow", undefined);
    },
  };
}

function shortened(text: string, limit = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function createPlanState(id: string, task: string, plan: string, interviewNotes: string): WorkflowPlanState {
  const timestamp = now();
  return {
    version: 1,
    id,
    task,
    status: "draft",
    plan,
    interviewNotes,
    createdAt: timestamp,
    updatedAt: timestamp,
    reviewRounds: 0,
    planPath: "",
    verificationMode: "packet",
  };
}

function taskWithUserAnswers(questions: string[], answer: string, round: number): string {
  return `## Interview round ${round}\n\nQuestions:\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}\n\nUser response:\n${answer.trim()}`;
}

function planReviewText(results: AgentResult[]): string {
  return formatAgentResults(results);
}

function agentJobId(phase: string, role: string, suffix?: string | number): string {
  return `workflow-${phase}-${role}${suffix === undefined ? "" : `-${suffix}`}`;
}

async function getTaskInput(rawArgs: string, ctx: ExtensionCommandContext, title: string): Promise<string> {
  const explicit = rawArgs.trim();
  if (explicit) return explicit;
  if (!ctx.hasUI) return "";
  return (await ctx.ui.editor(title, "Describe the outcome, constraints, non-goals, and what observable result would count as done."))?.trim() ?? "";
}

function renderAgentResult(result: AgentResult): string {
  const status = result.exitCode === 0 ? "completed" : `failed: ${result.error ?? `exit ${result.exitCode}`}`;
  return `## ${result.title} — ${status}\n\n${result.output}`;
}

function reviewRoles(config: WorkbenchConfig): Array<"quality-reviewer" | "technical-reviewer"> {
  return config.workflowMode === "thorough" ? ["quality-reviewer", "technical-reviewer"] : ["technical-reviewer"];
}

function reviewCount(config: WorkbenchConfig): 1 | 2 {
  return config.workflowMode === "thorough" ? 2 : 1;
}

export function registerWorkflow(pi: ExtensionAPI, dependencies: WorkflowDependencies): void {
  const { dashboard, exec, reprompterPath, report, getRoutingState } = dependencies;
  const runAgent = dependencies.runAgent ?? runSingleAgent;
  const withLease = dependencies.withLease ?? withExclusiveLease;
  const communityKnowledgePath = getCommunityKnowledgePath();

  async function resolveProject(ctx: ExtensionContext): Promise<{
    root: string;
    paths: ReturnType<typeof getProjectPaths>;
    workflowPaths: ReturnType<typeof getWorkflowPaths>;
    config: WorkbenchConfig;
  }> {
    const root = await findProjectRoot(ctx.cwd, exec);
    const paths = getProjectPaths(root);
    await ensureProjectState(paths);
    return { root, paths, workflowPaths: getWorkflowPaths(paths.stateDir), config: await loadConfig(paths) };
  }

  async function runRole(
    root: string,
    config: WorkbenchConfig,
    role: WorkflowAgentId,
    userTask: string,
    delegatedTask: string,
    progress: Progress,
    groupId: string,
    groupTitle: string,
    jobId: string,
    signal?: AbortSignal,
    effort: RoutingEffort = "auto",
    validateResult = true,
    model?: string,
  ): Promise<AgentResult> {
    throwIfWorkflowCancelled(signal);
    const base = getWorkflowAgentProfile(role);
    if (!base) throw new Error(`Unknown workflow agent: ${role}`);
    const route = routeTask({
      task: userTask,
      role,
      effort,
      policy: getRoutingState(),
      readOnly: base.readOnly,
      model,
    });
    const agent = resolveWorkflowAgent(role, config, userTask, effort, getRoutingState(), model);
    if (!agent) throw new Error(`Unknown workflow agent: ${role}`);
    const receipt = formatRoutingReceipt(agent.title, route);
    pi.appendEntry(MODEL_ROUTING_RECEIPT_ENTRY, { content: receipt });
    progress.update(receipt);
    const guidance = readOnlyBudgetGuidance(route);
    const result = await runAgent(
      root,
      agent,
      buildWorkflowSystemPrompt(agent, reprompterPath, userTask, communityKnowledgePath),
      guidance ? `${guidance}\n\n${delegatedTask}` : delegatedTask,
      signal,
      progress.update,
      { dashboard, groupId, groupTitle, jobId, budget: route.budget, contextTask: userTask },
    );
    throwIfWorkflowCancelled(signal);
    const routedResult: AgentResult = {
      ...result,
      routing: {
        effort: route.effort,
        model: route.model,
        thinking: route.thinking,
        reason: route.reason,
        ...(route.budget ? { budget: route.budget } : {}),
      },
    };
    return validateResult ? assertMandatoryAgentResult(routedResult, role) : routedResult;
  }

  async function runRoleBatch(
    root: string,
    config: WorkbenchConfig,
    tasks: Array<{ role: WorkflowAgentId; task: string; effort?: RoutingEffort; model?: string }>,
    userTask: string,
    progress: Progress,
    groupId: string,
    groupTitle: string,
    signal?: AbortSignal,
  ): Promise<AgentResult[]> {
    throwIfWorkflowCancelled(signal);
    if (tasks.length > config.workflowMaxParallelAgents) {
      throw new Error(`Workflow parallel limit is ${config.workflowMaxParallelAgents}; received ${tasks.length}.`);
    }
    const profiles = tasks.map(({ role }) => {
      const profile = resolveWorkflowAgent(role, config);
      if (!profile) throw new Error(`Unknown workflow agent: ${role}`);
      return profile;
    });
    const parallelError = tasks.length > 1 ? validateParallelWorkflowAgents(profiles) : undefined;
    if (parallelError) throw new Error(parallelError);
    const results = await Promise.all(tasks.map(({ role, task, effort, model }, index) => runRole(
      root,
      config,
      role,
      userTask,
      task,
      progress,
      groupId,
      groupTitle,
      agentJobId(groupId, role, index + 1),
      signal,
      effort,
      false,
      model,
    )));
    throwIfWorkflowCancelled(signal);
    return assertMandatoryAgentBatch(results, groupTitle);
  }

  async function reviewPlan(
    root: string,
    config: WorkbenchConfig,
    task: string,
    plan: string,
    progress: Progress,
    round: number | string,
    signal?: AbortSignal,
    reviewHistory = "",
    model?: string,
  ): Promise<AgentResult[]> {
    const roles = reviewRoles(config);
    progress.update(`plan review ${round}: ${roles.join(", ")}`);
    return runRoleBatch(
      root,
      config,
      roles.map((role) => ({ role, task: buildPlanReviewTask(role, task, plan, reviewHistory), model })),
      task,
      progress,
      `plan-review-${round}`,
      `Plan review ${round}`,
      signal,
    );
  }

  async function createPlan(
    root: string,
    projectPaths: ReturnType<typeof getProjectPaths>,
    config: WorkbenchConfig,
    task: string,
    ctx: ExtensionCommandContext,
    progress: Progress,
    options: { autonomous: boolean; autoApprove: boolean; revision?: { previous: WorkflowPlanState; feedback: string } },
    signal?: AbortSignal,
  ): Promise<PlanningResult> {
    const workflowPaths = getWorkflowPaths(projectPaths.stateDir);
    const id = createWorkflowPlanId(task);
    let interviewNotes = options.revision
      ? [options.revision.previous.interviewNotes, `Revision of plan ${options.revision.previous.id}.\nUSER REVISION REQUEST:\n${options.revision.feedback || "Resolve the remaining material blockers while preserving the original task."}`].filter(Boolean).join("\n\n")
      : "";
    let state = createPlanState(id, task, options.revision?.previous.plan ?? "# Planning in progress", interviewNotes);
    await saveWorkflowPlan(workflowPaths, state);
    throwIfWorkflowCancelled(signal);
    const discoveryRoles = selectPlanningDiscoveryAgentIds(task);
    progress.update(`discovery: ${discoveryRoles.join(" + ")}`);
    const discoveryResults = await runRoleBatch(
      root,
      config,
      discoveryRoles.map((role) => ({ role, task: buildDiscoveryTask(task, role as "codebase-explorer" | "researcher") })),
      task,
      progress,
      "planning-discovery",
      "Planning discovery",
      signal,
    );
    throwIfWorkflowCancelled(signal);
    const discovery = formatAgentResults(discoveryResults);
    await writeWorkflowRunArtifact(workflowPaths, id, "discovery.md", discovery);

    let clearance: PlanningClearance = { ready: false, questions: [], assumptions: [] };
    for (let round = 0; round <= config.workflowMaxInterviewRounds; round++) {
      progress.update(`Planner clearance assessment ${round + 1}`);
      const result = await runRole(
        root,
        config,
        "planner",
        task,
        buildClearanceTask(task, discovery, interviewNotes, options.autonomous, options.revision?.previous.plan),
        progress,
        "planning-clearance",
        "Planner interview",
        agentJobId("clearance", "planner", round + 1),
        signal,
      );
      throwIfWorkflowCancelled(signal);
      const clearancePath = await writeWorkflowRunArtifact(workflowPaths, id, `clearance-${round + 1}.md`, result.output);
      const parsedClearance = inspectPlanningClearance(result.output);
      if (!parsedClearance.ok) {
        state.status = "blocked";
        state.plan = options.revision?.previous.plan ?? "# Planning blocked\n\nPlanner returned an invalid clearance verdict.";
        state.updatedAt = now();
        state.interviewNotes = interviewNotes;
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("blocked", "Planner clearance was invalid");
        report("Workflow plan blocked", `Planner clearance could not be validated: ${parsedClearance.reason}\n\nNo later planning phase was launched.\n\nClearance output: ${clearancePath}\nPlan: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      clearance = parsedClearance.clearance;
      if (clearance.ready) break;

      if (options.autonomous) {
        state.plan = `# Planning blocked\n\nPlanner found a critical ambiguity that autonomous assumptions cannot safely resolve.\n\n${result.output}`;
        state.interviewNotes = interviewNotes;
        state.status = "blocked";
        state.updatedAt = now();
        await saveWorkflowPlan(workflowPaths, state);
        return { state, cancelled: false, executable: false };
      }
      if (round >= config.workflowMaxInterviewRounds) break;
      progress.pause();
      const answer = await ctx.ui.editor(
        `Planner interview — round ${round + 1}`,
        `${clearance.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}\n\nWrite your answers below:\n`,
      );
      if (answer === undefined) {
        state.status = "cancelled";
        state.interviewNotes = interviewNotes;
        state.updatedAt = now();
        await saveWorkflowPlan(workflowPaths, state);
        return { state, cancelled: true, executable: false };
      }
      interviewNotes += `${interviewNotes ? "\n\n" : ""}${taskWithUserAnswers(clearance.questions, answer, round + 1)}`;
    }

    if (!clearance.ready) {
      progress.pause();
      const proceed = await ctx.ui.confirm(
        "Planner still sees unresolved decisions",
        "Continue by recording them as explicit assumptions? Quality Reviewer and Technical Reviewer will independently review the resulting plan.",
      );
      if (!proceed) {
        state.status = "cancelled";
        state.interviewNotes = interviewNotes;
        state.updatedAt = now();
        await saveWorkflowPlan(workflowPaths, state);
        return { state, cancelled: true, executable: false };
      }
      clearance = {
        ready: true,
        questions: [],
        assumptions: [...clearance.assumptions, ...clearance.questions.map((question) => `Unresolved question treated conservatively: ${question}`)],
      };
    }

    throwIfWorkflowCancelled(signal);
    progress.update(config.workflowMode === "thorough" ? "Requirements Analyst checking hidden gaps and scope" : "Planner owns requirements and plan");
    const requirementsAnalysis = config.workflowMode === "thorough" ? await runRole(
      root,
      config,
      "requirements-analyst",
      task,
      buildRequirementsAnalysisTask(task, discovery, interviewNotes, clearance),
      progress,
      "planning-gap-analysis",
      "Requirements Analyst gap analysis",
      agentJobId("gap-analysis", "requirements-analyst"),
      signal,
    ) : { output: `Assess material requirements gaps as part of your plan. Preserve these explicit assumptions:\n${clearance.assumptions.join("\n")}` };
    throwIfWorkflowCancelled(signal);
    await writeWorkflowRunArtifact(workflowPaths, id, "requirements-analysis.md", requirementsAnalysis.output);

    progress.update("Planner writing decision-complete plan");
    let planResult = await runRole(
      root,
      config,
      "planner",
      task,
      buildPlannerTask(task, discovery, interviewNotes, requirementsAnalysis.output, options.revision?.previous.plan),
      progress,
      "planning-synthesis",
      "Planner plan",
      agentJobId("plan", "planner", 1),
      signal,
    );
    throwIfWorkflowCancelled(signal);
    let plan = planResult.output.trim();
    state.plan = plan;
    state.interviewNotes = interviewNotes;
    state.updatedAt = now();
    let reviewedPacket: WorkflowTaskPacket;
    try {
      reviewedPacket = bindWorkflowTaskPacket(plan);
    } catch (error) {
      state.status = "blocked";
      await saveWorkflowPlan(workflowPaths, state);
      progress.finish("blocked", "Planner produced an invalid workflow task packet");
      report("Workflow plan blocked", `The plan cannot be reviewed because its workflow task packet is invalid: ${error instanceof Error ? error.message : String(error)}\n\nDraft: ${state.planPath}`);
      return { state, cancelled: false, executable: false };
    }
    await saveWorkflowPlan(workflowPaths, state);

    let reviews: AgentResult[] = [];
    const reviewHistory: string[] = [];
    for (let round = 1; round <= config.workflowMaxPlanReviewLoops; round++) {
      await writeWorkflowRunArtifact(workflowPaths, id, `plan-draft-${round}.md`, plan);
      reviews = await reviewPlan(root, config, task, plan, progress, round, signal, reviewHistory.join("\n\n"));
      throwIfWorkflowCancelled(signal);
      state.reviewRounds = round;
      state.updatedAt = now();
      await writeWorkflowRunArtifact(workflowPaths, id, `plan-review-${round}.md`, planReviewText(reviews));
      reviewHistory.push(`### Review round ${round}\n${planReviewText(reviews)}`);
      if (planReviewsPass(reviews, reviewCount(config))) break;
      if (round >= config.workflowMaxPlanReviewLoops) {
        state.status = "blocked";
        state.plan = plan;
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("blocked", `Plan review still has blockers after ${round} rounds`);
        report("Workflow plan blocked", `Independent review still reports material blockers after ${round} rounds.\n\n${planReviewText(reviews)}\n\nDraft: ${state.planPath}\n\nUse \`/plan --revise <feedback>\` to carry this task and draft into a new reviewed attempt. No implementation was started.`);
        return { state, cancelled: false, executable: false };
      }
      progress.update(`Planner revising rejected plan — round ${round}`);
      planResult = await runRole(
        root,
        config,
        "planner",
        task,
        buildPlanRevisionTask(task, plan, reviewHistory.join("\n\n")),
        progress,
        "planning-revision",
        "Planner revision",
        agentJobId("plan-revision", "planner", round),
        signal,
      );
      throwIfWorkflowCancelled(signal);
      plan = planResult.output.trim();
      state.plan = plan;
      state.updatedAt = now();
      try {
        reviewedPacket = bindWorkflowTaskPacket(plan);
      } catch (error) {
        state.status = "blocked";
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("blocked", "Planner revision has an invalid workflow task packet");
        report("Workflow plan blocked", `The revised plan cannot be reviewed because its workflow task packet is invalid: ${error instanceof Error ? error.message : String(error)}\n\nDraft: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      await saveWorkflowPlan(workflowPaths, state);
    }

    if (options.autoApprove) {
      throwIfWorkflowCancelled(signal);
      state.status = "approved";
      state.plan = plan;
      state.verificationMode = "packet";
      state.packet = reviewedPacket;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      return { state, cancelled: false, executable: true };
    }

    progress.pause();
    const edited = await ctx.ui.editor("Review implementation plan", plan);
    if (edited === undefined) {
      state.status = "cancelled";
      state.plan = plan;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      return { state, cancelled: true, executable: false };
    }
    const editedPlan = edited.trim();
    if (!editedPlan) {
      state.status = "cancelled";
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      return { state, cancelled: true, executable: false };
    }
    if (editedPlan !== plan.trim()) {
      state.plan = editedPlan;
      state.status = "draft";
      state.updatedAt = now();
      try {
        reviewedPacket = bindWorkflowTaskPacket(editedPlan);
      } catch (error) {
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("needs_attention", "The edited plan has an invalid workflow task packet");
        report("Edited plan needs revision", `The user-edited plan remains a draft because its workflow task packet is invalid: ${error instanceof Error ? error.message : String(error)}\n\nDraft: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      await saveWorkflowPlan(workflowPaths, state);
      await writeWorkflowRunArtifact(workflowPaths, id, "plan-draft-user-edit.md", editedPlan);
      const editedReviews = await reviewPlan(root, config, task, editedPlan, progress, "user-edit", signal, reviewHistory.join("\n\n"));
      throwIfWorkflowCancelled(signal);
      state.reviewRounds += 1;
      await writeWorkflowRunArtifact(workflowPaths, id, "plan-review-user-edit.md", planReviewText(editedReviews));
      if (!planReviewsPass(editedReviews, reviewCount(config))) {
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("needs_attention", "The edited plan needs another revision");
        report("Edited plan needs revision", `The user-edited plan remains a draft because an independent reviewer found a blocker.\n\n${planReviewText(editedReviews)}\n\nDraft: ${state.planPath}`);
        return { state, cancelled: false, executable: false };
      }
      plan = editedPlan;
    }

    progress.pause();
    const approved = await ctx.ui.confirm(
      "Approve this workflow plan?",
      "Approval makes it executable by /start-work. Source files have not been changed yet.",
    );
    throwIfWorkflowCancelled(signal);
    state.plan = plan;
    state.status = approved ? "approved" : "draft";
    state.verificationMode = approved ? "packet" : undefined;
    state.packet = approved ? reviewedPacket : undefined;
    state.updatedAt = now();
    await saveWorkflowPlan(workflowPaths, state);
    return { state, cancelled: false, executable: approved };
  }

  async function executePlan(
    root: string,
    projectPaths: ReturnType<typeof getProjectPaths>,
    config: WorkbenchConfig,
    state: WorkflowPlanState,
    progress: Progress,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const workflowPaths = getWorkflowPaths(projectPaths.stateDir);
    throwIfWorkflowCancelled(signal);
    state.status = "executing";
    state.updatedAt = now();
    state.execution = {
      startedAt: now(),
      attempts: 0,
      verificationPassed: false,
    };
    await saveWorkflowPlan(workflowPaths, state);

    progress.update(config.workflowMode === "thorough" ? "Execution Manager sequencing approved work" : "Implementer owns the approved sequence");
    const executionManager = config.workflowMode === "thorough" ? await runRole(
      root,
      config,
      "execution-manager",
      state.task,
      buildExecutionBriefTask(state.task, state.plan, state.packet),
      progress,
      "execution-management",
      "Execution management",
      agentJobId("execution", "execution-manager"),
      signal,
    ) : { output: "## Execution\nFollow the approved plan directly. Inspect before editing, resolve implementation details from repository evidence, and report any material blocker.\n\n## Blockers\nNone" };
    throwIfWorkflowCancelled(signal);
    await writeWorkflowRunArtifact(workflowPaths, state.id, "execution-brief.md", executionManager.output);
    if (parseExecutionBlockerVerdict(executionManager.output) !== "clear") {
      state.status = "blocked";
      state.execution.summary = "Execution Manager reported a pre-implementation blocker.";
      state.execution.completedAt = now();
      await saveWorkflowPlan(workflowPaths, state);
      progress.finish("blocked", "Execution Manager reported a pre-implementation blocker");
      report("Workflow execution blocked", `${executionManager.output}\n\nPlan: ${state.planPath}`);
      return false;
    }

    progress.update("Implementer implementing the approved plan");
    let implementation = await runRole(
      root,
      config,
      "implementer",
      state.task,
      buildImplementationTask(state.task, state.plan, executionManager.output, state.packet),
      progress,
      "execution-worker",
      "Implementer implementation",
      agentJobId("implementation", "implementer", 1),
      signal,
    );
    throwIfWorkflowCancelled(signal);
    await writeWorkflowRunArtifact(workflowPaths, state.id, "implementation-1.md", implementation.output);

    for (let attempt = 0; attempt <= config.workflowMaxFixLoops; attempt++) {
      throwIfWorkflowCancelled(signal);
      const cycle = attempt + 1;
      state.execution.attempts = cycle;
      state.updatedAt = now();
      await saveWorkflowPlan(workflowPaths, state);

      progress.update(`review cycle ${cycle}: independent code review`);
      const reviews = await runRoleBatch(
        root,
        config,
        reviewRoles(config).map((role) => ({ role, task: buildCodeReviewTask(role, state.task, state.plan, implementation.output, state.packet) })),
        state.task,
        progress,
        `execution-review-${cycle}`,
        `Execution review ${cycle}`,
        signal,
      );
      throwIfWorkflowCancelled(signal);
      const reviewsText = formatAgentResults(reviews);
      await writeWorkflowRunArtifact(workflowPaths, state.id, `reviews-${cycle}.md`, reviewsText);

      progress.update(`verification cycle ${cycle}: canonical checks`);
      const verificationTask = state.packet
        ? buildPacketVerificationTask(state.task, state.plan, implementation.output, state.packet)
        : buildIndependentVerificationTask(state.task, state.plan, implementation.output);
      const verification = await runRole(
        root,
        config,
        "quality-reviewer",
        state.task,
        verificationTask,
        progress,
        `execution-verification-${cycle}`,
        `Verification ${cycle}`,
        agentJobId("verification", "gate", cycle),
        signal,
      );
      throwIfWorkflowCancelled(signal);
      const packetVerification: WorkflowPacketVerification | undefined = state.packet
        ? evaluateWorkflowVerification(verification.output, state.packet, verification.verification)
        : undefined;
      const verificationRecord = packetVerification
        ? JSON.stringify(packetVerification, null, 2)
        : verification.output;
      await writeWorkflowRunArtifact(workflowPaths, state.id, `verification-${cycle}.md`, verificationRecord);
      await writeWorkflowRunArtifact(workflowPaths, state.id, `checks-${cycle}.md`, JSON.stringify(verification.verification ?? { receipts: [] }, null, 2));
      if (packetVerification) {
        state.execution.packetVerification = packetVerification;
        state.updatedAt = now();
        await saveWorkflowPlan(workflowPaths, state);
      }
      const verificationPassed = packetVerification
        ? packetVerificationPasses(packetVerification)
        : legacyVerificationPasses(verification.output) && Boolean(verification.verification?.receipts.length
          && verification.verification.receipts.every((receipt) => checkPassed(receipt, verification.verification!.snapshot)));

      if (codeReviewsPass(reviews, reviewCount(config)) && verificationPassed) {
        throwIfWorkflowCancelled(signal);
        state.status = "verified";
        state.updatedAt = now();
        state.execution.verificationPassed = true;
        state.execution.completedAt = now();
        state.execution.summary = `Verified after ${cycle} review cycle${cycle === 1 ? "" : "s"}.`;
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("completed", `Verified after ${cycle} review cycle${cycle === 1 ? "" : "s"}`);
        report("Workflow work verified", `The approved plan was implemented and independently verified.\n\n${verificationRecord}\n\nPlan: ${state.planPath}\nRun evidence: ${pathJoinForDisplay(workflowPaths.runs, state.id)}`);
        return true;
      }

      if (attempt >= config.workflowMaxFixLoops) {
        state.status = "blocked";
        state.updatedAt = now();
        state.execution.completedAt = now();
        state.execution.summary = `Verification did not pass after ${cycle} cycles.`;
        await saveWorkflowPlan(workflowPaths, state);
        progress.finish("blocked", `Verification did not pass after ${cycle} cycles`);
        report("Workflow work not verified", `The workflow exhausted its bounded fix loops and refuses to claim completion.\n\n${reviewsText}\n\n${verificationRecord}\n\nPlan: ${state.planPath}`);
        return false;
      }

      progress.update(`Implementer fixing cycle ${cycle}`);
      implementation = await runRole(
        root,
        config,
        "implementer",
        state.task,
        buildFixTask(
          state.task,
          state.plan,
          implementation.output,
          reviewsText,
          packetVerification ? formatWorkflowVerificationFailures(packetVerification) : verification.output,
          state.packet,
        ),
        progress,
        `execution-fix-${cycle}`,
        `Fix cycle ${cycle}`,
        agentJobId("fix", "implementer", cycle),
        signal,
      );
      throwIfWorkflowCancelled(signal);
      await writeWorkflowRunArtifact(workflowPaths, state.id, `implementation-${cycle + 1}.md`, implementation.output);
    }
    return false;
  }

  function pathJoinForDisplay(...parts: string[]): string {
    return parts.join("/").replace(/\/+/g, "/");
  }

  async function runPlanningCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!/^--pipeline(?:\s|$)/i.test(rawArgs.trim())) return startCoordinatorPlanning(rawArgs, ctx);
    rawArgs = rawArgs.trim().replace(/^--pipeline\s*/i, "");
    const trustRequired = guardSubagentLaunch(ctx);
    if (trustRequired) {
      report("Project trust required", trustRequired);
      return;
    }
    if (!ctx.hasUI) {
      report("Planner unavailable", "`/plan` requires interactive UI for its interview and approval checkpoints.");
      return;
    }
    const request = await getTaskInput(rawArgs, ctx, "Planner planning request");
    if (!request) return;
    const project = await resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    const revise = /^(?:--revise(?:\s|$)|revise (?:the )?plan[.!]?$)/i.test(request.trim());
    const previous = revise ? authority.state : undefined;
    if (revise && (!previous || previous.execution || previous.status === "executing" || previous.status === "verified")) {
      report("Workflow revision unavailable", "`/plan --revise` requires an existing plan whose implementation has not started. Use `/plan <full task>` for new work.");
      return;
    }
    const task = previous?.task ?? request;
    const revision = previous ? { previous, feedback: request.trim().startsWith("--") ? request.trim().replace(/^--revise\s*/i, "") : "" } : undefined;
    const confirmed = await ctx.ui.confirm(
      revision ? "Revise the current workflow plan?" : "Start high-accuracy Workflow planning?",
      `${revision ? `Carry forward task: ${task}\nPrevious plan: ${previous!.id}\n\n` : ""}Pi will use the ${project.config.workflowMode} workflow: discovery, a bounded Planner interview, planning, and up to ${project.config.workflowMaxPlanReviewLoops} independent review rounds. No source files will be changed.`,
    );
    if (!confirmed) return;

    const runController = new AbortController();
    try {
      await withLease(project.root, "plan", async () => {
        await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
        dashboard.beginRun(`workflow-plan-${Date.now()}`, runController);
        const progress = progressFor(pi, ctx, "Planner", task, "plan");
        try {
          const result = await createPlan(project.root, project.paths, project.config, task, ctx, progress, { autonomous: false, autoApprove: false, revision }, runController.signal);
          if (result.state) {
            report(
              result.state.status === "approved" ? "Workflow plan approved" : "Workflow plan saved",
              `${formatWorkflowPlanStatus(result.state)}\n\n${result.state.status === "approved" ? "Run `/start-work` when ready." : "Use `/plan --revise <feedback>` to preserve this task and draft, or `/plan <full task>` for a new request."}`,
            );
          }
          progress.finish(result.cancelled ? "cancelled" : result.state?.status === "blocked" ? "blocked" : "completed", result.cancelled ? "Planning cancelled" : result.state?.status === "blocked" ? "Planning blocked" : "Planning finished");
        } catch (error) {
          const cancelled = isWorkflowCancellation(error, runController.signal);
          const message = error instanceof Error ? error.message : String(error);
          try {
            const current = await loadCurrentWorkflowPlan(project.workflowPaths);
            if (current && current.status !== "blocked" && current.status !== "verified") {
              current.status = cancelled ? "cancelled" : "interrupted";
              current.updatedAt = now();
              await saveWorkflowPlan(project.workflowPaths, current);
            }
          } catch {
            // The original planning failure remains authoritative.
          }
          progress.finish(cancelled ? "cancelled" : "interrupted", cancelled ? "Planning cancelled" : "Planning interrupted");
          report(cancelled ? "Workflow planning cancelled" : "Workflow planning interrupted", `${message}\n\nNo implementation was started.`);
        } finally {
          progress.clear();
          dashboard.endRun();
        }
      });
    } catch (error) {
      report(
        error instanceof WorkflowStateSnapshotMismatchError ? "Workflow state changed" : "Workflow writer unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function runStartWorkCommand(_rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!/^--pipeline(?:\s|$)/i.test(_rawArgs.trim())) return startCoordinatorExecution(_rawArgs, ctx);
    const trustRequired = guardSubagentLaunch(ctx);
    if (trustRequired) {
      report("Project trust required", trustRequired);
      return;
    }
    if (!ctx.hasUI) {
      report("Execution Manager unavailable", "`/start-work` requires interactive UI for the write confirmation.");
      return;
    }
    const project = await resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    const state = authority.state;
    if (!state) {
      report("No workflow plan", "Run `/plan <task>` first.");
      return;
    }
    if (state.status !== "approved") {
      report("Plan is not executable", `${formatWorkflowPlanStatus(state)}\n\nOnly an approved plan can run. Use \`/plan\` to review or replace it.`);
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Start approved work?",
      `Implementer will modify the current working tree, followed by independent review and up to ${project.config.workflowMaxFixLoops} fix loops. Existing unrelated changes must be preserved.`,
    );
    if (!confirmed) return;

    const runController = new AbortController();
    try {
      await withLease(project.root, "start-work", async () => {
        const confirmedState = await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
        if (!confirmedState) throw new WorkflowStateSnapshotMismatchError();
        dashboard.beginRun(`workflow-execute-${Date.now()}`, runController);
        const progress = progressFor(pi, ctx, "Execution Manager", confirmedState.task, "execution");
        try {
          await executePlan(project.root, project.paths, project.config, confirmedState, progress, runController.signal);
        } catch (error) {
          const cancelled = isWorkflowCancellation(error, runController.signal);
          const message = error instanceof Error ? error.message : String(error);
          confirmedState.status = cancelled ? "cancelled" : "interrupted";
          confirmedState.updatedAt = now();
          if (confirmedState.execution) {
            confirmedState.execution.completedAt = now();
            confirmedState.execution.summary = message;
          }
          await saveWorkflowPlan(project.workflowPaths, confirmedState);
          progress.finish(cancelled ? "cancelled" : "interrupted", cancelled ? "Execution cancelled" : "Execution interrupted");
          report(cancelled ? "Workflow execution cancelled" : "Workflow execution interrupted", `${message}\n\nThe work is not marked complete.`);
        } finally {
          progress.clear();
          dashboard.endRun();
        }
      });
    } catch (error) {
      report(
        error instanceof WorkflowStateSnapshotMismatchError ? "Workflow state changed" : "Workflow writer unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function runAutopilotCommand(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    const trustRequired = guardSubagentLaunch(ctx);
    if (trustRequired) {
      report("Project trust required", trustRequired);
      return;
    }
    if (!ctx.hasUI) {
      report("Autopilot unavailable", "`/autopilot` requires interactive UI for its initial cost and write confirmation.");
      return;
    }
    const task = await getTaskInput(rawArgs, ctx, "Autopilot request");
    if (!task) return;
    const project = await resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    const confirmed = await ctx.ui.confirm(
      "Start autopilot?",
      `Pi will use the ${project.config.workflowMode} workflow to plan with explicit assumptions, implement, independently review, and verify with recorded checks. Limits: ${project.config.workflowMaxPlanReviewLoops} plan-review rounds and ${project.config.workflowMaxFixLoops} fix loops.`,
    );
    if (!confirmed) return;

    const runController = new AbortController();
    try {
      await withLease(project.root, "autopilot", async () => {
        await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
        dashboard.beginRun(`workflow-autopilot-${Date.now()}`, runController);
        const progress = progressFor(pi, ctx, "Autopilot", task, "autopilot");
        try {
          const planning = await createPlan(project.root, project.paths, project.config, task, ctx, progress, { autonomous: true, autoApprove: true }, runController.signal);
          throwIfWorkflowCancelled(runController.signal);
          if (!planning.state || !planning.executable) {
            progress.finish(planning.cancelled ? "cancelled" : "needs_attention", planning.cancelled ? "Planning cancelled" : "Planning did not produce an executable plan");
            report("Autopilot stopped at planning", planning.state ? formatWorkflowPlanStatus(planning.state) : "Planning was cancelled.");
            return;
          }
          await executePlan(project.root, project.paths, project.config, planning.state, progress, runController.signal);
        } catch (error) {
          const cancelled = isWorkflowCancellation(error, runController.signal);
          const message = error instanceof Error ? error.message : String(error);
          const current = await loadCurrentWorkflowPlan(project.workflowPaths);
          if (current && current.status !== "verified" && current.status !== "blocked") {
            current.status = cancelled ? "cancelled" : "interrupted";
            current.updatedAt = now();
            if (current.execution) {
              current.execution.completedAt = now();
              current.execution.summary = message;
            }
            await saveWorkflowPlan(project.workflowPaths, current);
          }
          progress.finish(cancelled ? "cancelled" : "interrupted", cancelled ? "Autopilot cancelled" : "Autopilot interrupted");
          report(cancelled ? "Autopilot cancelled" : "Autopilot interrupted", `${message}\n\nThe Coordinator refuses to claim completion without the verification gate.`);
        } finally {
          progress.clear();
          dashboard.endRun();
        }
      });
    } catch (error) {
      report(
        error instanceof WorkflowStateSnapshotMismatchError ? "Workflow state changed" : "Autopilot writer unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const startCoordinatorPlanning = registerCoordinatorPlanning(pi, {
    resolveProject,
    withLease,
    report,
    async review(project, state, history, signal, ctx, model) {
      const ownsRun = !dashboard.state.currentRunId;
      if (ownsRun) dashboard.beginRun(`coordinator-review-${Date.now()}`);
      const progress = progressFor(pi, ctx, "Coordinator", state.task, "plan", false);
      try {
        return await reviewPlan(project.root, project.config, state.task, state.plan, progress, state.reviewRounds, signal, history, model);
      } finally {
        progress.clear();
        if (ownsRun) dashboard.endRun();
      }
    },
  });

  async function coordinatorRole<T>(state: WorkflowPlanState, ctx: ExtensionContext, work: (progress: Progress) => Promise<T>): Promise<T> {
    const ownsRun = !dashboard.state.currentRunId;
    if (ownsRun) dashboard.beginRun(`coordinator-execute-${Date.now()}`);
    const progress = progressFor(pi, ctx, "Coordinator", state.task, "execution", false);
    try { return await work(progress); }
    finally { progress.clear(); if (ownsRun) dashboard.endRun(); }
  }
  const startCoordinatorExecution = registerCoordinatorExecution(pi, {
    resolveProject, withLease, report,
    implement(project, state, task, model, signal, ctx) {
      return coordinatorRole(state, ctx, (progress) => runRole(
        project.root, project.config, "implementer", state.task,
        buildImplementationTask(state.task, state.plan, `Main Pi's bounded assignment:\n${task}\nDo only this slice; return evidence and open questions to Main Pi.`, state.packet),
        progress, "coordinator-implementation", "Implementation", agentJobId("coordinator", "implementer", Date.now()), signal, "auto", true, model,
      ));
    },
    verify(project, state, assessment, model, signal, ctx) {
      return coordinatorRole(state, ctx, async (progress) => {
        const reviews = await runRoleBatch(project.root, project.config,
          reviewRoles(project.config).map((role) => ({ role, task: buildCodeReviewTask(role, state.task, state.plan, "", state.packet), model })),
          state.task, progress, "coordinator-review", "Independent review", signal);
        const verification = await runRole(project.root, project.config, "quality-reviewer", state.task,
          state.packet ? buildPacketVerificationTask(state.task, state.plan, "", state.packet) : buildIndependentVerificationTask(state.task, state.plan, ""),
          progress, "coordinator-verification", "Native verification", agentJobId("coordinator", "verification", Date.now()), signal);
        return { reviews, verification };
      });
    },
  });

  pi.registerTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: "Delegate a focused task with an adaptive per-lane model route, or run multiple independently routed read-only specialists in parallel. Write-capable agents must run alone. Output is capped at 50KB per agent.",
    promptSnippet: "Delegate focused work to Pi's specialized workflow agents",
    promptGuidelines: [
      "Use delegate_task when isolated specialist context or independent parallel analysis materially improves a complex task; keep simple work in the main Pi agent.",
      "Main Pi acts as Coordinator: delegate bounded outcomes with context and success criteria, then verify returned claims against the actual project.",
      "Before delegating, classify every lane from complexity, uncertainty, risk, breadth, and verification cost. Role is only a prior: hard scout/recon work may require Sol. Set effort explicitly when you have made that judgment; otherwise use auto.",
      "Honor a requested model with the model parameter, for example openai-codex/gpt-6-astra:high. This overrides session routing for that delegation only; effort still controls its work budget. Unavailable models fail without substitution.",
      "Show the pre-launch route receipt. Never use Spark for visual/image work. Never run Implementer or Task Implementer in a parallel delegate_task batch or hard-cap mutation-capable work.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(StringEnum(WORKFLOW_AGENT_IDS, { description: "Agent for single delegation" })),
      task: Type.Optional(Type.String({ description: "Task for single delegation" })),
      effort: Type.Optional(RoutingEffortSchema),
      model: Type.Optional(Type.String({ description: "Exact provider/model[:thinking] for single delegation, e.g. openai-codex/gpt-6-astra:high" })),
      tasks: Type.Optional(Type.Array(TaskItemSchema, { minItems: 1, maxItems: 6, description: "Read-only tasks to run in parallel" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<DelegationToolDetails>> {
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      if (Number(hasSingle) + Number(hasParallel) !== 1) throw new Error("Provide exactly one mode: agent + task, or tasks[].");
      const trustRequired = guardSubagentLaunch(ctx);
      if (trustRequired) {
        return {
          content: [{ type: "text", text: trustRequired }],
          details: { mode: hasParallel ? "parallel" : "single", results: [], routes: [], blocked: trustRequired },
        };
      }
      if (hasParallel && params.model !== undefined) throw new Error("For parallel delegation, set model on each tasks[] entry.");
      for (const item of params.tasks ?? [{ model: params.model }]) requireAvailableDelegationModel(ctx, item.model);
      const project = await resolveProject(ctx);
      const ownsRun = !dashboard.state.currentRunId;
      if (ownsRun) dashboard.beginRun(`workflow-tool-${Date.now()}`);
      const delegationTitle = params.tasks?.map((item) => item.task).join(" / ") ?? params.task ?? "Delegation";
      const progress = progressFor(pi, ctx, "Delegation", delegationTitle, "delegate", false);
      try {
        if (params.tasks?.length) {
          const profiles = params.tasks.map((item) => resolveWorkflowAgent(item.agent, project.config)).filter((item): item is WorkflowAgentProfile => Boolean(item));
          const safetyError = validateParallelWorkflowAgents(profiles);
          if (safetyError) throw new Error(safetyError);
          const routes = params.tasks.map((item) => {
            const profile = getWorkflowAgentProfile(item.agent)!;
            const route = routeTask({ task: item.task, role: item.agent, effort: item.effort ?? "auto", policy: getRoutingState(), readOnly: profile.readOnly, model: item.model });
            return { role: item.agent, route, receipt: formatRoutingReceipt(profile.title, route) };
          });
          onUpdate?.({
            content: [{ type: "text", text: "Delegation in progress." }],
            details: { mode: "parallel", results: [], routes },
          });
          const results = await runRoleBatch(
            project.root,
            project.config,
            params.tasks.map((item) => ({ role: item.agent, task: item.task, effort: item.effort, model: item.model })),
            params.tasks.map((item) => item.task).join("\n"),
            progress,
            `tool-parallel-${Date.now()}`,
            "Delegation",
            signal,
          );
          return {
            content: [{ type: "text", text: formatAgentResults(results) }],
            details: { mode: "parallel", results, routes },
          };
        }
        const role = params.agent as WorkflowAgentId;
        const profile = resolveWorkflowAgent(role, project.config);
        if (!profile) throw new Error(`Unknown workflow agent: ${String(params.agent)}`);
        const task = params.task ?? "";
        if (!profile.readOnly) {
          if (!ctx.hasUI) throw new Error("Write-capable delegation requires interactive confirmation.");
          const confirmed = await ctx.ui.confirm(`Run ${profile.title}?`, "This specialist can modify the current working tree. It will run alone under the project writer lease.");
          if (!confirmed) throw new Error("Write-capable delegation was not approved.");
        }
        const route = routeTask({ task, role, effort: params.effort ?? "auto", policy: getRoutingState(), readOnly: profile.readOnly, model: params.model });
        const routes = [{ role, route, receipt: formatRoutingReceipt(profile.title, route) }];
        onUpdate?.({
          content: [{ type: "text", text: "Delegation in progress." }],
          details: { mode: "single", results: [], routes },
        });
        const launch = () => runRole(
          project.root,
          project.config,
          role,
          task,
          task,
          progress,
          `tool-single-${Date.now()}`,
          "Delegation",
          agentJobId("tool", role, Date.now()),
          signal,
          params.effort ?? "auto",
          true,
          params.model,
        );
        const result = profile.readOnly ? await launch() : await withLease(project.root, "delegate-task", launch);
        return { content: [{ type: "text", text: renderAgentResult(result) }], details: { mode: "single", results: [result], routes } };
      } finally {
        progress.clear();
        if (ownsRun) dashboard.endRun();
      }
    },
    renderCall(args, theme) {
      if (args.tasks?.length) {
        return new Text(`${theme.fg("toolTitle", theme.bold("delegate_task "))}${theme.fg("accent", `${args.tasks.length} read-only agents`)}`, 0, 0);
      }
      return new Text(`${theme.fg("toolTitle", theme.bold("delegate_task "))}${theme.fg("accent", args.agent ?? "agent")}${theme.fg("dim", ` ${shortened(args.task ?? "")}`)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as DelegationToolDetails | undefined;
      if (details?.blocked) return new Text(theme.fg("warning", details.blocked), 0, 0);
      if (isPartial) {
        const receipts = details?.routes?.map((item) => item.receipt).join("\n");
        return new Text(theme.fg("warning", receipts || "Delegating…"), 0, 0);
      }
      const results = details?.results ?? [];
      const succeeded = results.filter((item) => item.exitCode === 0).length;
      return new Text(
        `${succeeded === results.length ? theme.fg("success", "✓") : theme.fg("warning", "◐")} ${theme.fg("toolTitle", `Delegation ${succeeded}/${results.length || 1}`)}${theme.fg("muted", " — expand for full reports")}`,
        0,
        0,
      );
    },
  });

  pi.registerCommand("delegate", {
    description: "Show the specialist roster, or run one specialist: /delegate <agent> <task>",
    handler: async (rawArgs, ctx) => {
      const [rawRole, ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
      if (!rawRole) {
        const project = await resolveProject(ctx);
        const state = await loadCurrentWorkflowPlan(project.workflowPaths);
        report("Pi workflow", `${formatWorkflowPlanStatus(state)}\n\n## Specialist roster\n${formatWorkflowRoster(project.config)}\n\n## Commands\n- \`/plan <task>\` — interview and produce a reviewed plan\n- \`/start-work\` — execute the approved plan\n- \`/autopilot <task>\` — autonomous planning and execution\n- \`/preferences\` — durable personalization\n- \`/skills-evolve\` — trusted skill synchronization`);
        return;
      }
      const trustRequired = guardSubagentLaunch(ctx);
      if (trustRequired) {
        report("Project trust required", trustRequired);
        return;
      }
      const project = await resolveProject(ctx);
      const profile = getWorkflowAgentProfile(rawRole);
      if (!profile) {
        report("Unknown workflow agent", `Available: ${WORKFLOW_AGENT_IDS.join(", ")}`);
        return;
      }
      let task = rest.join(" ").trim();
      if (!task && ctx.hasUI) task = (await ctx.ui.editor(profile.title, "Describe the focused delegated outcome and success criteria."))?.trim() ?? "";
      if (!task) return;
      if (!profile.readOnly) {
        if (!ctx.hasUI) {
          report("Write-capable delegation unavailable", "Write-capable specialists require interactive confirmation.");
          return;
        }
        const confirmed = await ctx.ui.confirm(`Run ${profile.title}?`, "This specialist can modify the current working tree. It will run alone under the project writer lease.");
        if (!confirmed) return;
      }
      dashboard.beginRun(`workflow-command-${Date.now()}`);
      const progress = progressFor(pi, ctx, profile.title, task, "delegate");
      try {
        const resolved = resolveWorkflowAgent(profile.id, project.config)!;
        const launch = () => runRole(
          project.root,
          project.config,
          resolved.id,
          task,
          task,
          progress,
          "manual-specialist",
          "Manual specialist",
          agentJobId("manual", profile.id, Date.now()),
        );
        const result = profile.readOnly ? await launch() : await withLease(project.root, "delegate-command", launch);
        progress.finish(result.exitCode === 0 ? "completed" : "failed", result.exitCode === 0 ? `${profile.title} completed` : `${profile.title} failed`);
        report(profile.title, renderAgentResult(result));
      } catch (error) {
        progress.finish("failed", error instanceof Error ? error.message : String(error));
        report(`${profile.title} failed`, error instanceof Error ? error.message : String(error));
      } finally {
        progress.clear();
        dashboard.endRun();
      }
    },
  });

  pi.registerCommand("workflow-status", {
    description: "Show the current plan status and evidence paths",
    handler: async (_args, ctx) => {
      const project = await resolveProject(ctx);
      const state = await loadCurrentWorkflowPlan(project.workflowPaths);
      report("Workflow status", `${formatWorkflowPlanStatus(state)}\n\n- State directory: ${project.workflowPaths.root}\n- Community hypothesis feed: ${communityKnowledgePath}`);
    },
  });

  pi.registerCommand("plan", {
    description: "Main Pi directs planning with native review tools; --revise keeps the draft, --pipeline uses automatic stages",
    handler: runPlanningCommand,
  });

  pi.registerCommand("start-work", {
    description: "Main Pi directs approved implementation and native verification; --pipeline uses automatic stages",
    handler: runStartWorkCommand,
  });

  pi.registerCommand("autopilot", {
    description: "Autonomously plan, implement, review, fix, and verify a complex task",
    handler: runAutopilotCommand,
  });
}
