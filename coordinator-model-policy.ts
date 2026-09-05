import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { captureWorkflowAuthority, saveWorkflowPlan, type WorkflowPaths } from "./workflow-state.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import { requireAvailableDelegationModel } from "./workflow-agents.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";
import { TASK_MODEL_ACTIONS, readTaskModelPolicy, setTaskModelPreference } from "./task-model-policy.ts";

interface Project { root: string; workflowPaths: WorkflowPaths }
interface Dependencies {
  resolveProject(ctx: ExtensionContext): Promise<Project>;
  withLease<T>(root: string, operation: "plan", work: () => Promise<T>): Promise<T>;
}

/** Policy captures the user's model choice; it does not grant approval to execute the plan. */
export function registerCoordinatorModelPolicy(pi: ExtensionAPI, deps: Dependencies): void {
  pi.registerTool({
    name: "workbench_model_policy",
    label: "Workbench Model Policy",
    description: "Record exact task/domain model preferences that survive later implementation, repair, review, and reload. Inspect policy or explicitly replace a requested model; no fallback is allowed for pinned scopes.",
    promptSnippet: "Persist a user's domain-specific model request once, then honor it across related actions",
    promptGuidelines: [
      "When the user requests a model for related work, record the exact model, domain, applicable actions, and their direction before delegating. Use stable domains such as ui-ux or backend.",
      "The reason records the user's actual direction. Do not invent authorization. Set replace=true only when the user has changed their model preference.",
      "Pass the matching domain on native review and implementation actions. Domain classification remains Main Pi's decision; unrelated work may use another domain. This policy does not approve implementation or change plan scope.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "set"] as const),
      planId: Type.Optional(Type.String()),
      domain: Type.Optional(Type.String()),
      actions: Type.Optional(Type.Array(StringEnum(TASK_MODEL_ACTIONS))),
      model: Type.Optional(Type.String({ description: "Exact provider/model[:thinking], with no fallback" })),
      reason: Type.Optional(Type.String({ description: "The user's model request and its scope" })),
      replace: Type.Optional(Type.Boolean({ description: "Explicitly replace overlapping preferences after the user changes their direction" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const trust = guardSubagentLaunch(ctx);
      if (trust) throw new Error(trust);
      const project = await deps.resolveProject(ctx);
      if (params.action === "status") {
        const state = (await captureWorkflowAuthority(project.workflowPaths)).state;
        if (params.planId && params.planId !== state?.id) throw new Error("The requested plan is no longer current.");
        const policy = state ? await readTaskModelPolicy(project.workflowPaths, state) : null;
        const details = { planId: state?.id ?? null, policy };
        return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
      }
      if (!params.planId || !params.domain || !params.actions || !params.model || !params.reason) {
        throw new Error("Setting model policy requires planId, domain, actions, exact model, and the user's direction in reason.");
      }
      requireAvailableDelegationModel(ctx, params.model);
      return deps.withLease(project.root, "plan", async () => {
        throwIfWorkflowCancelled(signal);
        const state = (await captureWorkflowAuthority(project.workflowPaths)).state;
        if (!state || state.id !== params.planId) throw new Error("The requested plan is no longer current.");
        if (state.status === "verified") throw new Error("This task is already complete; model preferences cannot alter its execution evidence.");
        const policy = await setTaskModelPreference(project.workflowPaths, state, {
          domain: params.domain!, actions: params.actions!, model: params.model!, reason: params.reason!, replace: params.replace,
        });
        // Model changes invalidate exact-state review/completion tickets as well as persisted policy digests.
        state.updatedAt = new Date(Math.max(Date.now(), Date.parse(state.updatedAt) + 1)).toISOString();
        await saveWorkflowPlan(project.workflowPaths, state);
        const details = { planId: state.id, policy };
        return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
      });
    },
  });
}
