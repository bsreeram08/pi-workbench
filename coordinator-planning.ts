import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./config.ts";
import type { AgentResult } from "./types.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import { requireAvailableDelegationModel } from "./workflow-agents.ts";
import { readTaskModelPolicy, resolveTaskModel, setTaskModelPreference } from "./task-model-policy.ts";
import { readReviewContinuity, summarizeReviewContinuity } from "./review-continuity.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";
import { WORKFLOW_PLAN_FORMAT, planReviewsPass, reviewProtocolValid, parsePlanVerdict } from "./workflow-prompts.ts";
import { bindWorkflowTaskPacket, visualPacketHasRequiredEvidence, type WorkflowTaskPacket } from "./workflow-task-packet.ts";
import { parsePlanRequest } from "./workflow-request.ts";
import { looksLikeVisualTask } from "./workflow-concepts.ts";
import {
  assertWorkflowAuthorityUnchanged, captureWorkflowAuthority, createWorkflowPlanId,
  isCompleteVisualDesignBrief, saveWorkflowPlan, writeWorkflowRunArtifact,
  type WorkflowAuthoritySnapshot, type WorkflowPaths, type WorkflowPlanState,
} from "./workflow-state.ts";

interface Project {
  root: string;
  config: WorkbenchConfig;
  workflowPaths: WorkflowPaths;
}

interface Dependencies {
  resolveProject(ctx: ExtensionContext): Promise<Project>;
  withLease<T>(root: string, operation: "plan", work: () => Promise<T>): Promise<T>;
  review(project: Project, state: WorkflowPlanState, history: string, signal: AbortSignal | undefined, ctx: ExtensionContext, model?: string): Promise<AgentResult[]>;
  report(title: string, body: string): void;
}

interface ReviewTicket {
  authority: WorkflowAuthoritySnapshot;
  packet: WorkflowTaskPacket;
}

function result(status: string, fields: Record<string, unknown> = {}) {
  const details = { status, ...fields };
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

function editable(state: WorkflowPlanState | undefined): state is WorkflowPlanState {
  return Boolean(state && !state.execution && state.status !== "executing" && state.status !== "verified");
}

function recoverable(state: WorkflowPlanState | undefined): boolean {
  if (!editable(state) || !state || state.status === "approved" || state.status === "cancelled" || !state.reviewRounds) return false;
  const attempt = state.planningReview;
  if (!attempt) return state.status === "draft" || state.status === "interrupted";
  try {
    return attempt.recoveryAttempts < 1 && ["passed", "running", "interrupted"].includes(attempt.status)
      && (attempt.inputDigest ? attempt.inputDigest === planningInputDigest(state) : state.designBrief === undefined)
      && bindWorkflowTaskPacket(state.plan).planDigest === attempt.planDigest;
  } catch { return false; }
}

function planningInputDigest(state: WorkflowPlanState): string {
  return createHash("sha256").update(JSON.stringify({ plan: state.plan, task: state.task, designBrief: state.designBrief })).digest("hex");
}

async function snapshotSavedPlan(paths: WorkflowPaths, state: WorkflowPlanState): Promise<WorkflowAuthoritySnapshot> {
  const authority = await captureWorkflowAuthority(paths);
  if (JSON.stringify(authority.state) !== JSON.stringify(state)) throw new Error("Workflow state changed while recording the reviewed plan.");
  return authority;
}

function handoff(state: WorkflowPlanState, maxRounds: number): string {
  return `You are the main Coordinator for this planning request. Own the major decisions and use the Workbench tools to carry them out.

Plan ID: ${state.id}
Original user task:
${state.task}

Prior draft and decisions (context, not approval):
${state.plan}
${state.interviewNotes}
${state.designBrief ? `Recorded design brief (preserve unless deliberately revised):\n${JSON.stringify(state.designBrief)}` : ""}
${state.surface === "visual" ? `
This is a visual plan. Completion is the rendered surface, not the diff. Interview taste before review: references (what it should look like), refusals (what it must not look like, including generic LLM/SaaS defaults), hierarchy, density, and motion. Use workbench_ask for those preferences. Copy the answers into designBrief on workbench_plan review: direction, hierarchy, interactions, responsiveAccessibility, constraints, references, and refusals. Review rejects a missing or incomplete brief and a packet without runtime-observation and artifact-inspection evidence. Do not submit a visual plan without that lock.
` : ""}

Explain your approach briefly, inspect the actual project, and make the consequential product and architecture decisions yourself. For material tradeoffs, record the chosen direction, evidence, alternatives considered, and why it fits the user. Routine choices need no options ceremony. Ask the user only when a preference or missing fact materially changes the outcome; use workbench_ask when useful.

Use read/search/bash for direct inspection. Use delegate_task for bounded expert questions and independent investigation when useful, selecting role and effort deliberately. Honor an explicit model=provider/model[:thinking] the user asked for on delegate_task or workbench_agent_start. Do not invent a model they did not request. Effort controls the budget independently. Persistent read-only help is available through workbench_agent_start. A Planner can advise or draft a bounded part, but you must assess its output, reconcile disagreements, and own the resulting plan. There is no mandatory scout, interview, or planner sequence. Keep the user informed of decisions and tradeoffs, without asking them to manage the agents. Isolated work belongs in ./.worktrees/<name> inside this project. If implementation will live in another Git checkout, name that toplevel in the plan and later pass it as workbench_execute root= / /review --root; never tell the user to cd elsewhere and start a second Pi, and never treat this session checkout as that other tree.

This is planning only: do not edit source files, delegate implementation, or launch /autopilot. Use workbench_plan to save workflow state, not direct edits to .pi files.

When the plan is ready, call workbench_plan with action=review, planId=${state.id}, and the complete plan text. The harness runs independent review and returns findings to you; it does not automatically rewrite the plan. Resolve material findings using evidence, preserve valid prior decisions, and resubmit if needed. Up to ${maxRounds} native review rounds are available in this attempt. Do not bypass rejection or restart a workflow yourself to evade the limit.

After review passes, summarize your decisions and call workbench_plan with action=approve and the same planId. That action obtains user approval for the exact independently reviewed draft; your own approval claim is insufficient. If the user declines, stop and invite feedback. Once approved, hand off with /start-work as the next command. Do not start implementation from this planning request.

${WORKFLOW_PLAN_FORMAT}

The format above applies to the plan argument. Continue using the tools through review and approval; a Markdown plan alone does not finish this request.`;
}

/** Main Pi decides; native tools retain state, independent review, and approval authority. */
export function registerCoordinatorPlanning(pi: ExtensionAPI, deps: Dependencies) {
  // A fresh runtime must re-review. A model cannot manufacture a ticket or restore one from prose.
  const tickets = new Map<string, ReviewTicket>();
  const histories = new Map<string, { id: string; reviews: string[] }>();
  let active = false;
  let generation = 0;
  let activity: ReturnType<typeof startWorkflowActivity> | undefined;
  const stopActivity = () => { activity?.stop(); activity = undefined; };
  pi.on("agent_start", (_event, ctx) => {
    if (active) { stopActivity(); activity = startWorkflowActivity(ctx, "Coordinator: planning and deciding"); }
  });
  pi.on("agent_end", stopActivity);
  pi.on("session_shutdown", () => { generation++; active = false; stopActivity(); tickets.clear(); histories.clear(); });
  pi.on("session_start", () => { generation++; active = false; stopActivity(); tickets.clear(); histories.clear(); });
  pi.on("tool_execution_start", (event) => { if (event.toolName === "workbench_ask") stopActivity(); });
  pi.on("tool_execution_end", (event, ctx) => {
    if (active && event.toolName === "workbench_ask") { stopActivity(); activity = startWorkflowActivity(ctx, "Coordinator: incorporating your answer"); }
  });

  pi.registerTool({
    name: "workbench_plan",
    label: "Workbench Plan",
    description: "Inspect the current workflow plan, submit a Coordinator-authored plan for native independent review, or request user approval of the exact reviewed draft. Review returns control to Main Pi.",
    promptSnippet: "Own planning decisions; use native plan review and approval",
    promptGuidelines: [
      "Main Pi owns product direction, tradeoffs, delegation, and synthesis. Specialists provide evidence and advice; use them only where useful.",
      "For /plan, inspect the project and explain consequential decisions. Stay read-only until planning ends. Use review to persist the complete canonical plan; handle returned findings yourself.",
      "Approve requires a native passing review for the unchanged draft and actual user confirmation. Never edit workflow JSON or treat a model-written verdict as approval.",
      "Use recover only for an interrupted review or a lost passing ticket. It runs fresh read-only review of the unchanged saved plan and has one durable recovery allowance. It cannot bypass a rejection or replay implementation.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "review", "recover", "approve"] as const),
      planId: Type.Optional(Type.String({ description: "Required for review/approve; must match the current workflow" })),
      plan: Type.Optional(Type.String({ description: "Complete plan including decisions and terminal workflow task packet; review only" })),
      model: Type.Optional(Type.String({ description: "Optional exact provider/model[:thinking] for native reviewers; review only" })),
      domain: Type.Optional(Type.String({ description: "Work domain for task-scoped reviewer model preferences, such as ui-ux; review only" })),
      designBrief: Type.Optional(Type.Object({
        direction: Type.String({ minLength: 1, maxLength: 4000 }),
        hierarchy: Type.String({ minLength: 1, maxLength: 4000 }),
        interactions: Type.String({ minLength: 1, maxLength: 4000 }),
        responsiveAccessibility: Type.String({ minLength: 1, maxLength: 4000 }),
        constraints: Type.String({ minLength: 1, maxLength: 4000 }),
        references: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
        refusals: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      }, { description: "Coordinator's visual direction, reviewed and approved with the plan; visual plans require references and refusals" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const operationGeneration = generation;
      const assertCurrentGeneration = () => { if (operationGeneration !== generation) throw new Error("Planning session changed; recover the saved review in the current session."); };
      const trust = guardSubagentLaunch(ctx);
      if (trust) throw new Error(trust);
      const project = await deps.resolveProject(ctx);
      const paths = project.workflowPaths;
      if (params.action === "status") {
        const authority = await captureWorkflowAuthority(paths);
        return result("status", {
          state: authority.state ?? null,
          reviewAvailable: tickets.get(project.root)?.authority.content === authority.content && authority.content !== undefined,
          recoveryAvailable: recoverable(authority.state),
        });
      }
      if (!params.planId) throw new Error("planId is required; inspect workbench_plan status first.");
      if (params.action === "approve") {
        if (params.plan !== undefined || params.model !== undefined || params.domain !== undefined || params.designBrief !== undefined) throw new Error("Approval cannot supply or alter a plan or reviewer; submit changes for review first.");
        const ticket = tickets.get(project.root);
        if (!ticket || ticket.authority.state?.id !== params.planId) throw new Error("A native passing review is required before approval.");
        await assertWorkflowAuthorityUnchanged(paths, ticket.authority);
        if (!ctx.hasUI) throw new Error("Plan approval requires interactive user confirmation.");
        stopActivity();
        const confirmed = await ctx.ui.confirm("Approve the Coordinator's reviewed plan?", `${ticket.authority.state.task}\n\nPlan: ${ticket.authority.state.planPath}\n\nApproval makes this exact draft executable by /start-work.`);
        if (!confirmed) {
          active = false;
          tickets.delete(project.root);
          await deps.withLease(project.root, "plan", async () => {
            assertCurrentGeneration();
            const state = (await assertWorkflowAuthorityUnchanged(paths, ticket.authority))!;
            state.status = "cancelled";
            if (state.planningReview) state.planningReview.status = "cancelled";
            state.updatedAt = new Date().toISOString();
            await saveWorkflowPlan(paths, state);
          });
          return result("approval_declined", { planId: params.planId });
        }
        return deps.withLease(project.root, "plan", async () => {
          throwIfWorkflowCancelled(signal);
          assertCurrentGeneration();
          if (tickets.get(project.root) !== ticket) throw new Error("The native review changed during confirmation; review again.");
          const state = (await assertWorkflowAuthorityUnchanged(paths, ticket.authority))!;
          state.status = "approved";
          state.packet = ticket.packet;
          state.verificationMode = "packet";
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(paths, state);
          tickets.delete(project.root);
          active = false;
          return result("approved", { planId: state.id, planPath: state.planPath, next: "Planning complete. /start-work executes the approved plan when requested." });
        });
      }
      const recovering = params.action === "recover";
      if (!recovering && (params.action !== "review" || !params.plan?.trim())) throw new Error("Review requires a complete plan.");
      if (recovering && (params.plan !== undefined || params.model !== undefined || params.domain !== undefined || params.designBrief !== undefined)) throw new Error("Recovery cannot change the saved plan or reviewer model; submit a normal review for changes.");
      const recoveryAuthority = recovering ? await captureWorkflowAuthority(paths) : undefined;
      if (recovering && (!recoverable(recoveryAuthority?.state) || recoveryAuthority?.state?.id !== params.planId)) throw new Error("This plan has no recoverable review, or its recovery allowance is exhausted. A user-requested revision is required.");
      if (recovering && tickets.get(project.root)?.authority.content === recoveryAuthority?.content) throw new Error("The current review ticket is still available; request approval instead.");
      const plan = recovering ? recoveryAuthority!.state!.plan : params.plan!.trim();
      let model = recovering ? recoveryAuthority!.state!.planningReview?.model : params.model;
      requireAvailableDelegationModel(ctx, model);
      const packet = bindWorkflowTaskPacket(plan);
      return deps.withLease(project.root, "plan", async () => {
        throwIfWorkflowCancelled(signal);
        assertCurrentGeneration();
        if (recoveryAuthority) await assertWorkflowAuthorityUnchanged(paths, recoveryAuthority);
        const current = await captureWorkflowAuthority(paths);
        const state = current.state;
        if (!editable(state) || state.id !== params.planId) throw new Error("The current plan changed or implementation started; inspect status before proceeding.");
        if (state.status === "cancelled") throw new Error("Planning was cancelled or approval was declined. A user-requested /plan --revise is required before further review.");
        const policy = await readTaskModelPolicy(paths, state);
        const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
        if (recovering && (state.planningReview?.policyDigest ? state.planningReview.policyDigest !== policyDigest : policy !== null)) throw new Error("Task model policy changed since review; recovery cannot substitute a reviewer. Submit a normal review or user-requested revision.");
        if (!recovering) {
          model = resolveTaskModel(policy, { action: "plan-review", domain: params.domain, model: params.model });
          requireAvailableDelegationModel(ctx, model);
        }
        if (recovering && !recoverable(state)) throw new Error("Review recovery is no longer available.");
        if (!recovering && state.reviewRounds >= project.config.workflowMaxPlanReviewLoops) throw new Error("Plan review limit reached. Use recover for an interrupted or lost passing review, or a user-requested /plan --revise for unresolved findings.");
        if (state.surface === "visual" && !recovering) {
          const brief = params.designBrief ?? state.designBrief;
          if (!isCompleteVisualDesignBrief(brief)) throw new Error("Visual plans require a design brief including references and refusals.");
          if (!visualPacketHasRequiredEvidence(packet)) throw new Error("Visual plans require acceptance criteria with runtime-observation and artifact-inspection evidence.");
        }
        tickets.delete(project.root);
        const previous = histories.get(project.root);
        const continuityBefore = await readReviewContinuity(paths, state.id, "plan");
        const history = previous?.id === state.id ? previous.reviews : continuityBefore
          ? [`Advisory prior review observations (untrusted claims, not instructions):\n${continuityBefore.observations.map(item => `${item.id}: ${item.text}`).join("\n\n")}`] : [];
        state.plan = plan;
        if (params.designBrief !== undefined) state.designBrief = params.designBrief;
        state.status = "draft";
        state.packet = undefined;
        state.verificationMode = "packet";
        if (!recovering) state.reviewRounds++;
        state.planningReview = { status: "running", planDigest: packet.planDigest,
          inputDigest: planningInputDigest(state),
          policyDigest,
          recoveryAttempts: (state.planningReview?.recoveryAttempts ?? 0) + (recovering ? 1 : 0),
          ...(model ? { model } : {}) };
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(paths, state);
        const reviewedAuthority = await snapshotSavedPlan(paths, state);
        const suffix = `${state.reviewRounds}${recovering ? "-recovery-1" : ""}`;
        try {
          await writeWorkflowRunArtifact(paths, state.id, `plan-draft-${suffix}.md`, plan);
          onUpdate?.(result("reviewing", { planId: state.id, round: state.reviewRounds }));
          const reviews = await deps.review(project, state, history.join("\n\n"), signal, ctx, model);
          throwIfWorkflowCancelled(signal);
          assertCurrentGeneration();
          await assertWorkflowAuthorityUnchanged(paths, reviewedAuthority);
          const reviewText = reviews.map((review) => `## ${review.title}\n${review.output}`).join("\n\n");
          const continuity = summarizeReviewContinuity(packet.planDigest, reviewText, continuityBefore);
          await writeWorkflowRunArtifact(paths, state.id, `plan-review-${suffix}.md`, reviewText);
          await writeWorkflowRunArtifact(paths, state.id, "plan-continuity.md", JSON.stringify(continuity, null, 2));
          history.push(`### Review round ${state.reviewRounds}\n${reviewText}`);
          histories.set(project.root, { id: state.id, reviews: history });
          const passed = planReviewsPass(reviews, project.config.workflowMode === "thorough" ? 2 : 1);
          const substantiveRejection = reviews.some(review => !review.cancelled && review.exitCode === 0 && reviewProtocolValid(review.output, "plan") && parsePlanVerdict(review.output) === "REJECT");
          const failedReview = !substantiveRejection && (reviews.length < (project.config.workflowMode === "thorough" ? 2 : 1) || reviews.some(review => review.cancelled || review.exitCode !== 0));
          const invalidProtocol = !substantiveRejection && !failedReview && reviews.some(review => !reviewProtocolValid(review.output, "plan"));
          state.planningReview.status = passed ? "passed" : failedReview || invalidProtocol ? "interrupted" : "rejected";
          if (failedReview || invalidProtocol) state.planningReview.error = failedReview ? "Review did not finish successfully." : "Reviewer returned an invalid terminal verdict.";
          state.status = passed ? "draft" : failedReview || invalidProtocol ? "interrupted" : "blocked";
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(paths, state);
          if (passed) {
            const authority = await snapshotSavedPlan(paths, state);
            assertCurrentGeneration();
            tickets.set(project.root, { authority, packet });
          }
          return result(passed ? "review_passed" : failedReview ? "review_failed" : invalidProtocol ? "protocol_invalid" : "changes_required", {
            planId: state.id, planPath: state.planPath, reviews: reviewText,
            continuity,
            remainingReviewRounds: project.config.workflowMaxPlanReviewLoops - state.reviewRounds,
            next: passed ? "Explain your decisions, then request native approval with action=approve." : "Assess the findings, correct the plan, and resubmit within the remaining review budget. Do not implement.",
          });
        } catch (error) {
          // Never overwrite a concurrent replacement, and never restore authority from an old receipt.
          await assertWorkflowAuthorityUnchanged(paths, reviewedAuthority);
          state.planningReview.status = signal?.aborted ? "cancelled" : "interrupted";
          state.planningReview.error = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
          state.status = signal?.aborted ? "cancelled" : "interrupted";
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(paths, state);
          active = false; stopActivity();
          throw error;
        }
      });
    },
  });

  return async function start(request: string, ctx: ExtensionCommandContext, options: { visual?: boolean } = {}): Promise<void> {
    const trust = guardSubagentLaunch(ctx);
    if (trust) { deps.report("Project trust required", trust); return; }
    if (!ctx.hasUI) { deps.report("Planner unavailable", "/plan requires interactive UI."); return; }
    const parsed = parsePlanRequest(request.trim());
    let taskText = parsed.task;
    if (!parsed.revise && !taskText) taskText = (await ctx.ui.editor("Planning request", ""))?.trim() ?? "";
    if (!parsed.revise && !taskText) return;
    const project = await deps.resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    const previous = parsed.revise ? authority.state : undefined;
    if (parsed.revise && !editable(previous)) { deps.report("Workflow revision unavailable", "Revision requires an existing plan whose implementation has not started."); return; }
    const feedback = parsed.feedback;
    const timestamp = new Date().toISOString();
    const task = previous?.task ?? taskText;
    let visual = options.visual || parsed.visual || previous?.surface === "visual";
    if (!visual && !options.visual && !parsed.revise && looksLikeVisualTask(task)) {
      visual = await ctx.ui.confirm("This looks like visual/UI work. Use the visual loop (taste lock + browser capture)?", task);
    }
    const state: WorkflowPlanState = {
      version: 1, id: createWorkflowPlanId(task), task, status: "draft",
      plan: previous?.plan ?? "# Planning in progress",
      ...(previous?.designBrief ? { designBrief: previous.designBrief } : {}),
      ...(visual ? { surface: "visual" as const } : {}),
      interviewNotes: [previous?.interviewNotes, feedback && `User revision request: ${feedback}`].filter(Boolean).join("\n\n"),
      createdAt: timestamp, updatedAt: timestamp, reviewRounds: 0, planPath: "", verificationMode: "packet",
    };
    try {
      stopActivity();
      activity = startWorkflowActivity(ctx, "Coordinator: preparing planning context");
      await deps.withLease(project.root, "plan", async () => {
        await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
        const priorPolicy = previous ? await readTaskModelPolicy(project.workflowPaths, previous) : null;
        await saveWorkflowPlan(project.workflowPaths, state);
        for (const preference of priorPolicy?.preferences ?? []) await setTaskModelPreference(project.workflowPaths, state, preference);
        tickets.delete(project.root);
        histories.delete(project.root);
      });
      // Queue after releasing the lease: the parent uses ordinary tools between native actions.
      active = true;
      pi.sendUserMessage(handoff(state, project.config.workflowMaxPlanReviewLoops), { deliverAs: "followUp", expandPromptTemplates: false });
      deps.report("Coordinator planning started", `Main Pi owns the decisions and delegation. Independent review and approval use workbench_plan.\n\nPlan: ${state.planPath}`);
    } catch (error) {
      active = false;
      stopActivity();
      deps.report("Coordinator planning unavailable", error instanceof Error ? error.message : String(error));
    }
  };
}
