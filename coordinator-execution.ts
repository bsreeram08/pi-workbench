import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { WorkbenchConfig } from "./config.ts";
import type { AgentResult } from "./types.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { requireAvailableDelegationModel } from "./workflow-agents.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";
import { checkPassed, workspaceSnapshot } from "./verification.ts";
import { codeReviewsPass, legacyVerificationPasses } from "./workflow-prompts.ts";
import { evaluateWorkflowVerification, packetVerificationPasses } from "./workflow-task-packet.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import {
  assertWorkflowAuthorityUnchanged, captureWorkflowAuthority, saveWorkflowPlan, writeWorkflowRunArtifact,
  type WorkflowAuthoritySnapshot, type WorkflowPaths, type WorkflowPlanState,
} from "./workflow-state.ts";

interface Project { root: string; config: WorkbenchConfig; workflowPaths: WorkflowPaths }
interface Dependencies {
  resolveProject(ctx: ExtensionContext): Promise<Project>;
  withLease<T>(root: string, operation: "start-work", work: () => Promise<T>): Promise<T>;
  implement(project: Project, state: WorkflowPlanState, task: string, model: string, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AgentResult>;
  verify(project: Project, state: WorkflowPlanState, assessment: string, model: string | undefined, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<{ reviews: AgentResult[]; verification: AgentResult }>;
  report(title: string, body: string): void;
}

function result(status: string, fields: Record<string, unknown> = {}) {
  const details = { status, ...fields };
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

async function snapshotSavedState(paths: WorkflowPaths, state: WorkflowPlanState) {
  const authority = await captureWorkflowAuthority(paths);
  if (JSON.stringify(authority.state) !== JSON.stringify(state)) throw new Error("Workflow state changed while saving execution evidence.");
  return authority;
}

/** Main Pi sequences work; native actions own writer leases and completion evidence. */
export function registerCoordinatorExecution(pi: ExtensionAPI, deps: Dependencies) {
  const tickets = new Map<string, { authority: WorkflowAuthoritySnapshot; snapshot: string }>();
  let active = false;
  let activity: ReturnType<typeof startWorkflowActivity> | undefined;
  const stop = () => { activity?.stop(); activity = undefined; };
  pi.on("agent_start", (_event, ctx) => {
    if (active) { stop(); activity = startWorkflowActivity(ctx, "Coordinator: directing and inspecting implementation"); }
  });
  pi.on("agent_end", stop);
  pi.on("tool_execution_start", (event) => { if (event.toolName === "workbench_ask") stop(); });
  pi.on("tool_execution_end", (event, ctx) => {
    if (active && event.toolName === "workbench_ask") { stop(); activity = startWorkflowActivity(ctx, "Coordinator: incorporating your answer"); }
  });
  pi.on("session_start", () => { active = false; stop(); tickets.clear(); });
  pi.on("session_shutdown", () => { active = false; stop(); tickets.clear(); });

  pi.registerTool({
    name: "workbench_execute",
    label: "Workbench Execute",
    description: "Direct bounded implementation of the started approved plan, run independent review and native verification, or complete the unchanged verified work. Every action returns control to Main Pi.",
    promptSnippet: "Main Pi directs implementation, inspects changes, and owns the final decision",
    promptGuidelines: [
      "Use /start-work to authorize an approved plan first. Main Pi owns sequencing, product decisions, code inspection, and resolution of specialist findings.",
      "For implement, choose an exact model deliberately and honor the user's requested model. Give a bounded task with acceptance criteria. Inspect the actual diff and behavior after each result; do not forward a child summary as your own review.",
      "For verify, summarize your own inspection in assessment. Native independent review and verification return findings without automatic repair. Resolve blockers and call verify again within the budget.",
      "Complete only after independently checking the result yourself. Native completion requires unchanged workspace and passing review/check evidence. Material changes to the approved scope require user agreement, not silent adoption of reviewer proposals.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "implement", "verify", "complete"] as const),
      planId: Type.Optional(Type.String()),
      task: Type.Optional(Type.String({ description: "Bounded approved implementation or repair task; implement only" })),
      model: Type.Optional(Type.String({ description: "Exact provider/model[:thinking]; required for implement, optional for independent reviewers in verify" })),
      assessment: Type.Optional(Type.String({ description: "Main Pi's own code/behavior inspection and decisions; required for verify and complete" })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const trust = guardSubagentLaunch(ctx);
      if (trust) throw new Error(trust);
      const project = await deps.resolveProject(ctx);
      if (params.action === "status") return result("status", { state: (await captureWorkflowAuthority(project.workflowPaths)).state ?? null });
      if (!params.planId) throw new Error("planId is required.");
      if (params.action === "implement" && (!params.task?.trim() || !params.model)) throw new Error("Implementation requires a bounded task and an explicit model choice.");
      if ((params.action === "verify" || params.action === "complete") && !params.assessment?.trim()) throw new Error("Provide Main Pi's own inspection and decisions in assessment.");
      requireAvailableDelegationModel(ctx, params.model);
      return deps.withLease(project.root, "start-work", async () => {
        throwIfWorkflowCancelled(signal);
        const authority = await captureWorkflowAuthority(project.workflowPaths);
        const state = authority.state;
        if (!state?.execution || state.status !== "executing" || state.id !== params.planId) throw new Error("This plan has not been started, changed, or is no longer executing.");
        if (params.action === "complete") {
          const ticket = tickets.get(project.root);
          if (!ticket || ticket.authority.content !== authority.content) throw new Error("Passing native review and verification of the current state are required.");
          if (await workspaceSnapshot(project.root) !== ticket.snapshot) throw new Error("Workspace changed since review; verify again before completion.");
          throwIfWorkflowCancelled(signal);
          await assertWorkflowAuthorityUnchanged(project.workflowPaths, ticket.authority);
          state.status = "verified";
          state.execution.verificationPassed = true;
          state.execution.completedAt = new Date().toISOString();
          state.execution.summary = params.assessment;
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(project.workflowPaths, state);
          tickets.delete(project.root);
          active = false; stop();
          return result("verified", { planId: state.id, planPath: state.planPath });
        }
        tickets.delete(project.root);
        if (state.execution.attempts >= project.config.workflowMaxFixLoops + 1) throw new Error("Execution review limit reached. Report remaining blockers to the user; do not claim completion.");
        if (params.action === "implement") {
          onUpdate?.(result("implementing", { model: params.model, task: params.task }));
          const implementation = await deps.implement(project, state, params.task!, params.model!, signal, ctx);
          throwIfWorkflowCancelled(signal);
          await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `coordinator-implementation-${Date.now()}.md`, implementation.output);
          return result("implementation_returned", { output: implementation.output, next: "Main Pi must inspect the actual changes and behavior, make decisions, and request native verify when ready." });
        }
        if (params.action !== "verify") throw new Error("Unknown execution action.");
        state.execution.attempts++;
        state.execution.packetVerification = undefined;
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(project.workflowPaths, state);
        const reviewAuthority = await snapshotSavedState(project.workflowPaths, state);
        const before = await workspaceSnapshot(project.root);
        onUpdate?.(result("verifying", { cycle: state.execution.attempts }));
        const { reviews, verification } = await deps.verify(project, state, params.assessment!, params.model, signal, ctx);
        throwIfWorkflowCancelled(signal);
        await assertWorkflowAuthorityUnchanged(project.workflowPaths, reviewAuthority);
        const after = await workspaceSnapshot(project.root);
        const packetVerification = state.packet ? evaluateWorkflowVerification(verification.output, state.packet, verification.verification) : undefined;
        const checkEvidence = verification.verification;
        const passed = before === after && checkEvidence?.snapshot === after
          && codeReviewsPass(reviews, project.config.workflowMode === "thorough" ? 2 : 1)
          && (packetVerification ? packetVerificationPasses(packetVerification) : legacyVerificationPasses(verification.output)
            && Boolean(checkEvidence.receipts.length && checkEvidence.receipts.every((receipt) => checkPassed(receipt, after))));
        const cycle = state.execution.attempts;
        const findings = reviews.map((review) => `## ${review.title}\n${review.output}`).join("\n\n");
        await writeWorkflowRunArtifact(project.workflowPaths, state.id, `reviews-${cycle}.md`, findings);
        await writeWorkflowRunArtifact(project.workflowPaths, state.id, `verification-${cycle}.md`, packetVerification ? JSON.stringify(packetVerification, null, 2) : verification.output);
        await writeWorkflowRunArtifact(project.workflowPaths, state.id, `checks-${cycle}.md`, JSON.stringify(checkEvidence ?? { receipts: [] }, null, 2));
        await writeWorkflowRunArtifact(project.workflowPaths, state.id, `coordinator-assessment-${cycle}.md`, params.assessment!);
        state.execution.packetVerification = packetVerification;
        state.execution.summary = passed ? "Native gates passed; Main Pi must inspect and complete." : "Native gates did not pass; Main Pi must resolve findings.";
        if (!passed && cycle >= project.config.workflowMaxFixLoops + 1) {
          state.status = "blocked";
          state.execution.completedAt = new Date().toISOString();
          active = false; stop();
        }
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(project.workflowPaths, state);
        if (passed) tickets.set(project.root, { authority: await snapshotSavedState(project.workflowPaths, state), snapshot: after });
        return result(passed ? "verification_passed" : "changes_required", {
          reviews: findings, verification: packetVerification ?? verification.output,
          unchangedWorkspace: before === after, currentEvidence: checkEvidence?.snapshot === after,
          remainingCycles: project.config.workflowMaxFixLoops + 1 - cycle,
          next: passed ? "Main Pi must assess the results and call complete with its final assessment." : "Main Pi must assess findings and direct corrections. No automatic implementer was launched.",
        });
      });
    },
  });

  return async function start(instructions: string, ctx: ExtensionCommandContext) {
    const trust = guardSubagentLaunch(ctx);
    if (trust) { deps.report("Project trust required", trust); return; }
    if (!ctx.hasUI) { deps.report("Execution unavailable", "/start-work requires interactive confirmation."); return; }
    const project = await deps.resolveProject(ctx);
    const authority = await captureWorkflowAuthority(project.workflowPaths);
    if (authority.state?.status !== "approved") { deps.report("Plan is not executable", "Only an approved plan can start."); return; }
    if (!await ctx.ui.confirm("Start approved work with Main Pi coordinating?", `${authority.state.task}\n\nMain Pi will direct bounded implementation, inspect changes, resolve independent findings, and verify completion. Preserve unrelated work.`)) return;
    try {
      await deps.withLease(project.root, "start-work", async () => {
        const state = (await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority))!;
        state.status = "executing";
        state.execution = { startedAt: new Date().toISOString(), attempts: 0, verificationPassed: false };
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(project.workflowPaths, state);
        tickets.delete(project.root);
      });
      active = true;
      stop(); activity = startWorkflowActivity(ctx, "Coordinator: preparing implementation");
      pi.sendUserMessage(`You are Main Pi, responsible for executing this approved plan. Own the decisions and inspect the work yourself throughout.\nPlan ID: ${authority.state.id}\nTask: ${authority.state.task}\nApproved plan:\n${authority.state.plan}\nAdditional user directions: ${instructions || "Use the conversation's current instructions, including explicit model preferences."}\n\nExplain your first implementation slice and model choice. Call workbench_execute implement with a bounded task and an explicit model=provider/model[:thinking]; honor requested models such as openai-codex/gpt-6-astra:high for UI/UX implementation. After each child returns, inspect actual files, diffs, and behavior yourself before choosing the next step. You may use read-only specialists for advice. Use native implementation actions for writers so leases apply. Do not disappear into an automatic pipeline or simply repeat child summaries.\n\nReviewer recommendations are advice: adopt compatible improvements deliberately and obtain user agreement for material departures from the approved scope. When ready, call workbench_execute verify with your own assessment and optional reviewer model. It runs independent code review plus native verification and returns findings to you. Resolve blockers with bounded implement calls, then verify again within the limit. After passing gates, inspect the evidence and call complete with your final assessment. Do not mark workflow JSON directly, claim success from a child summary, or restart to evade limits.`, { deliverAs: "followUp", expandPromptTemplates: false });
      deps.report("Coordinator execution started", "Main Pi owns implementation decisions, inspection, and review follow-up. Native tools retain writer ownership and verification gates.");
    } catch (error) { active = false; stop(); deps.report("Coordinator execution unavailable", error instanceof Error ? error.message : String(error)); }
  };
}
