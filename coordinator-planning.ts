import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./config.ts";
import type { AgentResult } from "./types.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import { requireAvailableDelegationModel } from "./workflow-agents.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";
import { WORKFLOW_PLAN_FORMAT, planReviewsPass } from "./workflow-prompts.ts";
import { bindWorkflowTaskPacket, type WorkflowTaskPacket } from "./workflow-task-packet.ts";
import {
  assertWorkflowAuthorityUnchanged, captureWorkflowAuthority, createWorkflowPlanId,
  saveWorkflowPlan, writeWorkflowRunArtifact,
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

Explain your approach briefly, inspect the actual project, and make the consequential product and architecture decisions yourself. For material tradeoffs, record the chosen direction, evidence, alternatives considered, and why it fits the user. Routine choices need no options ceremony. Ask the user only when a preference or missing fact materially changes the outcome; use workbench_ask when useful.

Use read/search/bash for direct inspection. Use delegate_task for bounded expert questions and independent investigation when useful, selecting role and effort deliberately. Honor an explicit model request using model=provider/model[:thinking], such as openai-codex/gpt-6-astra:high, on delegate_task or workbench_agent_start. Effort controls the budget independently. Persistent read-only help is available through workbench_agent_start. A Planner can advise or draft a bounded part, but you must assess its output, reconcile disagreements, and own the resulting plan. There is no mandatory scout, interview, or planner sequence. Keep the user informed of decisions and tradeoffs, without asking them to manage the agents.

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
  let activity: ReturnType<typeof startWorkflowActivity> | undefined;
  const stopActivity = () => { activity?.stop(); activity = undefined; };
  pi.on("agent_start", (_event, ctx) => {
    if (active) { stopActivity(); activity = startWorkflowActivity(ctx, "Coordinator: planning and deciding"); }
  });
  pi.on("agent_end", stopActivity);
  pi.on("session_shutdown", () => { active = false; stopActivity(); tickets.clear(); histories.clear(); });
  pi.on("session_start", () => { active = false; stopActivity(); tickets.clear(); histories.clear(); });
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
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "review", "approve"] as const),
      planId: Type.Optional(Type.String({ description: "Required for review/approve; must match the current workflow" })),
      plan: Type.Optional(Type.String({ description: "Complete plan including decisions and terminal workflow task packet; review only" })),
      model: Type.Optional(Type.String({ description: "Optional exact provider/model[:thinking] for native reviewers; review only" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const trust = guardSubagentLaunch(ctx);
      if (trust) throw new Error(trust);
      const project = await deps.resolveProject(ctx);
      const paths = project.workflowPaths;
      if (params.action === "status") {
        const authority = await captureWorkflowAuthority(paths);
        return result("status", {
          state: authority.state ?? null,
          reviewAvailable: tickets.get(project.root)?.authority.content === authority.content && authority.content !== undefined,
        });
      }
      if (!params.planId) throw new Error("planId is required; inspect workbench_plan status first.");
      if (params.action === "approve") {
        if (params.plan !== undefined || params.model !== undefined) throw new Error("Approval cannot supply or alter a plan or reviewer; submit changes for review first.");
        const ticket = tickets.get(project.root);
        if (!ticket || ticket.authority.state?.id !== params.planId) throw new Error("A native passing review is required before approval.");
        await assertWorkflowAuthorityUnchanged(paths, ticket.authority);
        if (!ctx.hasUI) throw new Error("Plan approval requires interactive user confirmation.");
        stopActivity();
        const confirmed = await ctx.ui.confirm("Approve the Coordinator's reviewed plan?", `${ticket.authority.state.task}\n\nPlan: ${ticket.authority.state.planPath}\n\nApproval makes this exact draft executable by /start-work.`);
        if (!confirmed) {
          active = false;
          tickets.delete(project.root);
          return result("approval_declined", { planId: params.planId });
        }
        return deps.withLease(project.root, "plan", async () => {
          throwIfWorkflowCancelled(signal);
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
      if (params.action !== "review" || !params.plan?.trim()) throw new Error("Review requires a complete plan.");
      const plan = params.plan.trim();
      requireAvailableDelegationModel(ctx, params.model);
      const packet = bindWorkflowTaskPacket(plan);
      return deps.withLease(project.root, "plan", async () => {
        throwIfWorkflowCancelled(signal);
        const current = await captureWorkflowAuthority(paths);
        const state = current.state;
        if (!editable(state) || state.id !== params.planId) throw new Error("The current plan changed or implementation started; inspect status before proceeding.");
        if (state.reviewRounds >= project.config.workflowMaxPlanReviewLoops) throw new Error("Plan review limit reached. Report remaining findings to the user; a user-requested /plan --revise starts a new attempt.");
        tickets.delete(project.root);
        const previous = histories.get(project.root);
        const history = previous?.id === state.id ? previous.reviews : [];
        state.plan = plan;
        state.status = "draft";
        state.packet = undefined;
        state.verificationMode = "packet";
        state.reviewRounds++;
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(paths, state);
        const reviewedAuthority = await snapshotSavedPlan(paths, state);
        await writeWorkflowRunArtifact(paths, state.id, `plan-draft-${state.reviewRounds}.md`, plan);
        onUpdate?.(result("reviewing", { planId: state.id, round: state.reviewRounds }));
        const reviews = await deps.review(project, state, history.join("\n\n"), signal, ctx, params.model);
        throwIfWorkflowCancelled(signal);
        await assertWorkflowAuthorityUnchanged(paths, reviewedAuthority);
        const reviewText = reviews.map((review) => `## ${review.title}\n${review.output}`).join("\n\n");
        await writeWorkflowRunArtifact(paths, state.id, `plan-review-${state.reviewRounds}.md`, reviewText);
        history.push(`### Review round ${state.reviewRounds}\n${reviewText}`);
        histories.set(project.root, { id: state.id, reviews: history });
        const passed = planReviewsPass(reviews, project.config.workflowMode === "thorough" ? 2 : 1);
        state.status = passed ? "draft" : "blocked";
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(paths, state);
        if (passed) tickets.set(project.root, { authority: await snapshotSavedPlan(paths, state), packet });
        return result(passed ? "review_passed" : "changes_required", {
          planId: state.id, planPath: state.planPath, reviews: reviewText,
          remainingReviewRounds: project.config.workflowMaxPlanReviewLoops - state.reviewRounds,
          next: passed ? "Explain your decisions, then request native approval with action=approve." : "Assess the findings, correct the plan, and resubmit within the remaining review budget. Do not implement.",
        });
      });
    },
  });

  return async function start(request: string, ctx: ExtensionCommandContext): Promise<void> {
    const trust = guardSubagentLaunch(ctx);
    if (trust) { deps.report("Project trust required", trust); return; }
    if (!ctx.hasUI) { deps.report("Planner unavailable", "/plan requires interactive UI."); return; }
    const input = request.trim() || (await ctx.ui.editor("Planning request", ""))?.trim();
    if (!input) return;
    const project = await deps.resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    const revise = /^(?:--revise(?:\s|$)|revise (?:the )?plan[.!]?$)/i.test(input);
    const previous = revise ? authority.state : undefined;
    if (revise && !editable(previous)) { deps.report("Workflow revision unavailable", "Revision requires an existing plan whose implementation has not started."); return; }
    const feedback = revise && input.startsWith("--") ? input.replace(/^--revise\s*/i, "") : "";
    const timestamp = new Date().toISOString();
    const task = previous?.task ?? input;
    const state: WorkflowPlanState = {
      version: 1, id: createWorkflowPlanId(task), task, status: "draft",
      plan: previous?.plan ?? "# Planning in progress",
      interviewNotes: [previous?.interviewNotes, feedback && `User revision request: ${feedback}`].filter(Boolean).join("\n\n"),
      createdAt: timestamp, updatedAt: timestamp, reviewRounds: 0, planPath: "", verificationMode: "packet",
    };
    try {
      stopActivity();
      activity = startWorkflowActivity(ctx, "Coordinator: preparing planning context");
      await deps.withLease(project.root, "plan", async () => {
        await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
        await saveWorkflowPlan(project.workflowPaths, state);
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
