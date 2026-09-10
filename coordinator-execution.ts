import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { WorkbenchConfig } from "./config.ts";
import { buildImpactReceipt, readCachedImpactReceipt } from "./impact-receipt.ts";
import type { AgentResult } from "./types.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { requireAvailableDelegationModel } from "./workflow-agents.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";
import { checkPassed, workspaceSnapshot } from "./verification.ts";
import { codeReviewsPass, legacyVerificationPasses, reviewProtocolValid, parseCodeVerdict } from "./workflow-prompts.ts";
import { groundWorkflowFindings, parseWorkflowFindings } from "./workflow-findings.ts";
import { readReviewContinuity, summarizeReviewContinuity } from "./review-continuity.ts";
import { evaluateWorkflowVerification, packetVerificationPasses } from "./workflow-task-packet.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import { readTaskModelPolicy, resolveTaskModel } from "./task-model-policy.ts";
import { captureSupervisionInventory, compareSupervisionInventories, InspectionEvidenceStore, type InventoryResult } from "./supervision-evidence.ts";
import {
  assertWorkflowAuthorityUnchanged, captureWorkflowAuthority, saveWorkflowPlan, writeWorkflowRunArtifact,
  type WorkflowAuthoritySnapshot, type WorkflowPaths, type WorkflowPlanState,
} from "./workflow-state.ts";

interface Project { root: string; config: WorkbenchConfig; workflowPaths: WorkflowPaths }
interface Dependencies {
  resolveProject(ctx: ExtensionContext): Promise<Project>;
  withLease<T>(root: string, operation: "start-work", work: () => Promise<T>): Promise<T>;
  implement(project: Project, state: WorkflowPlanState, task: string, model: string, signal: AbortSignal | undefined, ctx: ExtensionContext, continuation?: { runId: string; expectedWorkspaceSnapshot: string }): Promise<AgentResult>;
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
  let generation = 0;
  let parentSession = randomUUID();
  const inspections = new InspectionEvidenceStore();
  const baselines = new Map<string, { planId: string; inventory: InventoryResult }>();
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
  const reset = () => { generation++; parentSession = randomUUID(); inspections.clear(); baselines.clear(); active = false; stop(); tickets.clear(); };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);

  pi.registerTool({
    name: "workbench_execute",
    label: "Workbench Execute",
    description: "Direct bounded implementation of the started approved plan, run independent review and native verification, or complete the unchanged verified work. Every action returns control to Main Pi.",
    promptSnippet: "Main Pi directs implementation, inspects changes, and owns the final decision",
    promptGuidelines: [
      "Use /start-work to authorize an approved plan first. Main Pi owns sequencing, product decisions, code inspection, and resolution of specialist findings.",
      "For implement, choose an exact model deliberately and honor the user's requested model. Give a bounded task with acceptance criteria. Inspect the actual diff and behavior after each result; do not forward a child summary as your own review.",
      "Record user model preferences once with workbench_model_policy; use the matching domain on later actions. For repair use repair=true. A closed writer checkpoint can continue once with only the new correction; unavailable or stale checkpoints require a fresh bounded assignment.",
      "Use inspect with relevant source paths. Its evidence IDs establish which content was returned to Main Pi, not comprehension. For an approved design brief also use visual to return a PNG for inspection; distinguish reported interactions from image evidence. Fix stale or wrong captures before changing UI.",
      "For verify, summarize your own inspection in assessment and cite current evidenceIds from inspect/visual. Native independent review and verification return findings without automatic repair. Resolve blockers and call verify again within the budget.",
      "After reload, inspect the current source again and use recover once to rerun interrupted or passing native verification without replaying a writer. Recovery cannot bypass rejected, cancelled, changed, or exhausted work.",
      "Complete only after independently checking the result yourself. Native completion requires unchanged workspace and passing review/check evidence. Material changes to the approved scope require user agreement, not silent adoption of reviewer proposals.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "inspect", "visual", "implement", "verify", "recover", "complete"] as const),
      artifactPath: Type.Optional(Type.String({ description: "PNG image to return to Main Pi for visual inspection; source provenance remains caller supplied" })),
      route: Type.Optional(Type.String({ description: "Reported route and interaction state depicted in the image" })),
      viewport: Type.Optional(Type.Object({ width: Type.Number(), height: Type.Number() })),
      observations: Type.Optional(Type.Array(Type.String({ description: "Reported interaction observations, not facts established by the image" }))),
      paths: Type.Optional(Type.Array(Type.String(), { description: "Source paths for inspect, or declared allowed paths for implementation" })),
      startLine: Type.Optional(Type.Integer({ minimum: 1, description: "First source line to return during inspection" })),
      changes: Type.Optional(Type.Boolean({ description: "Inspect a native deletion-only inventory or empty workspace when no source remains" })),
      evidenceIds: Type.Optional(Type.Array(Type.String(), { description: "Current native parent inspection IDs required for verify, recover, complete" })),
      domain: Type.Optional(Type.String({ description: "Work domain, e.g. ui-ux or backend; required when task model preferences apply" })),
      repair: Type.Optional(Type.Boolean({ description: "Implementation corrects previous work; honors the task's repair model scope" })),
      continuation: Type.Optional(Type.Object({ runId: Type.String(), expectedWorkspaceSnapshot: Type.String() }, { description: "Reuse a closed writer's native checkpoint once for a correction; never replay its original assignment" })),
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
      if (params.action === "implement" && !params.task?.trim()) throw new Error("Implementation requires a bounded task and an explicit model choice or task preference.");
      if (["verify", "recover", "complete"].includes(params.action) && !params.assessment?.trim()) throw new Error("Provide Main Pi's own inspection and decisions in assessment.");
      requireAvailableDelegationModel(ctx, params.model);
      const operationGeneration = generation;
      const assertActive = () => {
        throwIfWorkflowCancelled(signal);
        if (generation !== operationGeneration) throw new Error("Coordinator session changed; late results cannot authorize completion.");
      };
      return deps.withLease(project.root, "start-work", async () => {
        throwIfWorkflowCancelled(signal);
        const authority = await captureWorkflowAuthority(project.workflowPaths);
        const state = authority.state;
        if (!state?.execution || state.status !== "executing" || state.id !== params.planId) throw new Error("This plan has not been started, changed, or is no longer executing.");
        if (params.action === "inspect") {
          const baseline = baselines.get(project.root);
          const inspection = params.changes
            ? await inspections.inspectChanges({ root: project.root, sessionId: parentSession, planId: state.id, before: baseline?.planId === state.id ? baseline.inventory : undefined })
            : await inspections.inspect({ root: project.root, sessionId: parentSession, planId: state.id, paths: params.paths ?? [], startLine: params.startLine });
          assertActive();
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `parent-inspection-${inspection.receipt.id}.md`, JSON.stringify(inspection.receipt, null, 2));
          return result("inspected", inspection);
        }
        if (params.action === "visual") {
          if (!params.artifactPath || !params.route || !params.viewport) throw new Error("Visual inspection requires a PNG artifact, reported route, and viewport.");
          const visual = await inspections.visual({ root: project.root, sessionId: parentSession, planId: state.id,
            artifactPath: params.artifactPath, route: params.route, viewport: params.viewport, observations: params.observations?.join("\n") });
          assertActive();
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `visual-inspection-${visual.receipt.id}.md`, JSON.stringify(visual.receipt, null, 2));
          return { content: [...result("visual_inspected", { receipt: visual.receipt }).content, visual.image], details: { status: "visual_inspected", receipt: visual.receipt } };
        }
        const policy = await readTaskModelPolicy(project.workflowPaths, state);
        const policyDigest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
        const model = ["implement", "verify"].includes(params.action) ? resolveTaskModel(policy, {
          domain: params.domain, action: params.action === "implement" ? params.repair ? "repair" : "implement" : "review", model: params.model,
        }) : params.model;
        requireAvailableDelegationModel(ctx, model);
        if (params.action === "complete") {
          const ticket = tickets.get(project.root);
          if (!ticket || ticket.authority.content !== authority.content) throw new Error("Passing native review and verification of the current state are required.");
          if (await workspaceSnapshot(project.root) !== ticket.snapshot) throw new Error("Workspace changed since review; verify again before completion.");
          await inspections.assertCurrent({ root: project.root, sessionId: parentSession, planId: state.id, ids: params.evidenceIds ?? [], requireVisual: Boolean(state.designBrief) });
          assertActive();
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
        if (params.action === "recover" && tickets.has(project.root)) throw new Error("Current verification is already available; complete it instead.");
        if (params.action !== "recover" && state.execution.attempts >= project.config.workflowMaxFixLoops + 1) throw new Error("Execution review limit reached. Use recover once for an interrupted or reloaded passing verification; do not replay implementation.");
        if (params.action === "implement") {
          if (!model) throw new Error("Implementation requires an explicit model choice or a task model preference.");
          if (params.continuation && !params.repair) throw new Error("Writer continuation is reserved for a bounded repair assignment.");
          onUpdate?.(result("implementing", { model, task: params.task }));
          const assignmentId = randomUUID();
          const before = await captureSupervisionInventory(project.root);
          if (before.status !== "available") throw new Error(`Cannot observe implementation baseline: ${before.error}`);
          assertActive();
          tickets.delete(project.root);
          if (baselines.get(project.root)?.planId !== state.id) baselines.set(project.root, { planId: state.id, inventory: before });
          let implementation: AgentResult | undefined;
          let failure: unknown;
          try { implementation = await deps.implement(project, state, params.task!, model, signal, ctx, params.continuation); }
          catch (error) { failure = error; }
          if (implementation && (implementation.cancelled || implementation.exitCode !== 0 || !implementation.output.trim())) failure = new Error(implementation.error ?? "Writer did not return a successful nonblank result.");
          const changes = compareSupervisionInventories(before, await captureSupervisionInventory(project.root));
          let snapshot = "";
          try { snapshot = await workspaceSnapshot(project.root); } catch { /* Receipt still records the observed change list. */ }
          const runDir = path.join(project.workflowPaths.runs, state.id);
          const changedPaths = changes.status === "available" ? changes.changes.map((item) => item.path) : [];
          const impact = changes.status === "available"
            ? await readCachedImpactReceipt(runDir, snapshot, changedPaths) ?? await buildImpactReceipt({ root: project.root, snapshot, changes })
            : await buildImpactReceipt({ root: project.root, snapshot, changes });
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `impact-${assignmentId}.md`, JSON.stringify(impact, null, 2));
          const handoff = {
            assignmentId, planId: state.id, runId: implementation?.runId ?? null, requestedModel: model, resolvedRoute: implementation?.routing ?? null,
            continuation: implementation?.continuation ?? null,
            termination: signal?.aborted || implementation?.cancelled ? "cancelled" : failure ? "failed" : "completed",
            exitCode: implementation?.exitCode ?? null, changes, impact,
            scopeAnomalies: changes.status === "available" && params.paths ? changes.changes.filter((item) => !params.paths!.includes(item.path)).map((item) => item.path) : null,
            childClaims: implementation?.output ?? null, error: failure ? String(failure) : null,
            checkEvidence: implementation?.verification ?? null,
            next: "Main Pi must inspect actual source with the inspect action, check behavior, then decide to accept, repair, or escalate. These observations do not establish authorship or correctness.",
          };
          const artifact = await writeWorkflowRunArtifact(project.workflowPaths, state.id, `handoff-${assignmentId}.md`, JSON.stringify(handoff, null, 2));
          if (signal?.aborted || implementation?.cancelled) {
            await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
            state.status = "cancelled";
            state.execution.completedAt = new Date().toISOString();
            state.execution.summary = `Implementation cancelled. Partial-change handoff: ${artifact}`;
            state.updatedAt = new Date().toISOString();
            await saveWorkflowPlan(project.workflowPaths, state);
            active = false; stop();
            throw new Error(`Implementation cancelled; inspect partial changes in ${artifact}. No writer will be replayed.`);
          }
          assertActive();
          await assertWorkflowAuthorityUnchanged(project.workflowPaths, authority);
          if (failure) throw new Error(`Implementation failed; inspect partial changes in ${artifact}. ${String(failure)}`);
          return result("implementation_returned", { handoff, artifact });
        }
        if (params.action !== "verify" && params.action !== "recover") throw new Error("Unknown execution action.");
        const parentEvidence = await inspections.assertCurrent({ root: project.root, sessionId: parentSession, planId: state.id, ids: params.evidenceIds ?? [], requireVisual: Boolean(state.designBrief) });
        const digest = createHash("sha256").update(JSON.stringify({ plan: state.plan, designBrief: state.designBrief })).digest("hex");
        const before = await workspaceSnapshot(project.root);
        const priorReview = state.execution.review;
        const recovering = params.action === "recover";
        if (recovering) {
          if (!state.execution.attempts || (priorReview?.recoveryAttempts ?? 0) >= 1) throw new Error("No recovery remains for this execution.");
          if (priorReview && (["rejected", "cancelled"].includes(priorReview.status) || priorReview.planDigest !== digest || priorReview.snapshot !== before)) throw new Error("Recovery requires an unchanged interrupted or passing verification. Changed work needs a normal review cycle.");
          if (params.model && params.model !== priorReview?.model) throw new Error("Recovery must preserve the original reviewer model.");
          if (priorReview?.policyDigest ? priorReview.policyDigest !== policyDigest : policy !== null) throw new Error("Task model policy changed since verification; submit a normal review with the current preference.");
        }
        const reviewModel = recovering ? priorReview?.model : model;
        requireAvailableDelegationModel(ctx, reviewModel);
        assertActive();
        tickets.delete(project.root);
        if (!recovering) state.execution.attempts++;
        state.execution.review = { status: "running", planDigest: digest, snapshot: before, policyDigest,
          recoveryAttempts: (priorReview?.recoveryAttempts ?? 0) + (recovering ? 1 : 0), ...(reviewModel ? { model: reviewModel } : {}) };
        state.execution.packetVerification = undefined;
        state.updatedAt = new Date().toISOString();
        await saveWorkflowPlan(project.workflowPaths, state);
        const reviewAuthority = await snapshotSavedState(project.workflowPaths, state);
        onUpdate?.(result("verifying", { cycle: state.execution.attempts }));
        try {
          const { reviews, verification } = await deps.verify(project, state, params.assessment!, reviewModel, signal, ctx);
          assertActive();
          await assertWorkflowAuthorityUnchanged(project.workflowPaths, reviewAuthority);
          const after = await workspaceSnapshot(project.root);
          const packetVerification = state.packet ? evaluateWorkflowVerification(verification.output, state.packet, verification.verification) : undefined;
          const checkEvidence = verification.verification;
          const reviewsProtocolInvalid = reviews.some((review) => !reviewProtocolValid(review.output, "code"));
          let ungroundedFindings = false;
          if (!reviewsProtocolInvalid) {
            for (const review of reviews) {
              const parsed = parseWorkflowFindings(review.output);
              const grounded = parsed ? await groundWorkflowFindings(project.root, parsed) : { ok: false };
              if (!grounded.ok) { ungroundedFindings = true; break; }
            }
          }
          const passed = before === after && checkEvidence?.snapshot === after
            && codeReviewsPass(reviews, project.config.workflowMode === "thorough" ? 2 : 1)
            && !ungroundedFindings
            && (packetVerification ? packetVerificationPasses(packetVerification) : legacyVerificationPasses(verification.output)
              && Boolean(checkEvidence.receipts.length && checkEvidence.receipts.every((receipt) => checkPassed(receipt, after))));
          const substantiveRejection = !reviewsProtocolInvalid && !ungroundedFindings
            && reviews.some((review) => reviewProtocolValid(review.output, "code") && parseCodeVerdict(review.output) !== "PASS");
          const protocolFailure = !substantiveRejection && before === after
            && Boolean(checkEvidence?.receipts.length && checkEvidence.snapshot === after && checkEvidence.receipts.every((receipt) => checkPassed(receipt, after)))
            && (reviewsProtocolInvalid || ungroundedFindings || packetVerification?.result === "protocol-failure");
          const cycle = state.execution.attempts;
          const artifactCycle = `${cycle}${recovering ? "-recovery" : ""}`;
          const findings = reviews.map((review) => `## ${review.title}\n${review.output}`).join("\n\n");
          const continuity = summarizeReviewContinuity(after, findings, await readReviewContinuity(project.workflowPaths, state.id, "execution"));
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, "execution-continuity.md", JSON.stringify(continuity, null, 2));
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `reviews-${artifactCycle}.md`, findings);
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `verification-${artifactCycle}.md`, packetVerification ? JSON.stringify(packetVerification, null, 2) : verification.output);
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `checks-${artifactCycle}.md`, JSON.stringify(checkEvidence ?? { receipts: [] }, null, 2));
          await writeWorkflowRunArtifact(project.workflowPaths, state.id, `coordinator-assessment-${artifactCycle}.md`, JSON.stringify({ assessment: params.assessment, evidence: parentEvidence }, null, 2));
          state.execution.review.status = passed ? "passed" : protocolFailure ? "interrupted" : "rejected";
          state.execution.packetVerification = packetVerification;
          state.execution.summary = passed ? "Native gates passed; Main Pi must inspect and complete." : "Native gates did not pass; Main Pi must resolve findings.";
          if (!passed && !protocolFailure && cycle >= project.config.workflowMaxFixLoops + 1) {
            state.status = "blocked";
            state.execution.completedAt = new Date().toISOString();
            active = false; stop();
          }
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(project.workflowPaths, state);
          if (passed) {
            const saved = await snapshotSavedState(project.workflowPaths, state);
            assertActive();
            tickets.set(project.root, { authority: saved, snapshot: after });
          }
          return result(passed ? "verification_passed" : protocolFailure ? "verification_protocol_invalid" : "changes_required", {
            continuity,
            reviews: findings, verification: packetVerification ?? verification.output,
            unchangedWorkspace: before === after, currentEvidence: checkEvidence?.snapshot === after,
            remainingCycles: project.config.workflowMaxFixLoops + 1 - cycle,
            next: passed ? "Main Pi must assess the results and call complete with its final assessment." : protocolFailure ? "Malformed review output is not approval. Use recover once for fresh native review of the same workspace; do not rewrite product code to repair the protocol." : "Main Pi must assess findings and direct corrections. No automatic implementer was launched.",
          });
        } catch (error) {
          // Preserve the consumed cycle and its inputs. Only an explicit, bounded,
          // read-only recovery can obtain fresh authority after infrastructure failure.
          await assertWorkflowAuthorityUnchanged(project.workflowPaths, reviewAuthority);
          state.execution.review.status = signal?.aborted ? "cancelled" : "interrupted";
          state.execution.review.error = String(error).slice(0, 4000);
          if (signal?.aborted) {
            state.status = "cancelled";
            state.execution.completedAt = new Date().toISOString();
          }
          state.updatedAt = new Date().toISOString();
          await saveWorkflowPlan(project.workflowPaths, state);
          throw error;
        }
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
      pi.sendUserMessage(`You are Main Pi, responsible for executing this approved plan. Own the decisions and inspect the work yourself throughout.\nPlan ID: ${authority.state.id}\nTask: ${authority.state.task}\nApproved plan:\n${authority.state.plan}\nAdditional user directions: ${instructions || "Use the conversation's current instructions, including explicit model preferences."}\n\nExplain your first implementation slice and model choice. Call workbench_execute implement with a bounded task and an explicit model=provider/model[:thinking]; honor a model the user asked for, and do not invent one. If isolation is needed, keep it in ./.worktrees/<name> inside this project and add .worktrees/ to .gitignore; never tell the user to cd elsewhere and start a second Pi. After each child returns, inspect actual files, diffs, and behavior yourself before choosing the next step. Use workbench_execute inspect with relevant source paths to receive native evidence IDs; ordinary prose is not an inspection receipt. If this plan has a designBrief, use visual to return a PNG and record the reported route, viewport and observed interactions. A supplied image does not prove a fresh browser capture or keyboard behavior. Record the user's scoped model choices with workbench_model_policy, then pass domain on related actions; use repair=true for corrections. A returned continuation checkpoint permits one closed-writer continuation with the new correction only, up to three turns, while the workspace/model/task match. You may use read-only specialists for advice. Use native implementation actions for writers so leases apply. Do not disappear into an automatic pipeline or simply repeat child summaries.\n\nReviewer recommendations are advice: adopt compatible improvements deliberately and obtain user agreement for material departures from the approved scope. When ready, call workbench_execute verify with your own assessment, current evidenceIds and optional reviewer model. It runs independent code review plus native verification and returns findings to you. Resolve blockers with bounded implement calls, then verify again within the limit. After passing gates, inspect the evidence and call complete with your final assessment and current evidenceIds. If reload lost a passing ticket, inspect again and use recover for one fresh read-only verification; never replay implementation to regain authority. Do not mark workflow JSON directly, claim success from a child summary, or restart to evade limits.`, { deliverAs: "followUp", expandPromptTemplates: false });
      deps.report("Coordinator execution started", "Main Pi owns implementation decisions, inspection, and review follow-up. Native tools retain writer ownership and verification gates.");
    } catch (error) { active = false; stop(); deps.report("Coordinator execution unavailable", error instanceof Error ? error.message : String(error)); }
  };
}
