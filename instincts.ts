import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { findProjectRoot } from "./project.ts";
import {
  INSTINCT_DOMAINS,
  renderInstinctL1,
  WorkbenchInstinctStore,
  type InstinctDomain,
  type InstinctScope,
} from "./instinct-store.ts";
import type { Exec } from "./types.ts";

interface InstinctDependencies {
  exec: Exec;
  report(title: string, body: string): void;
}

const INSTINCT_ACTIONS = ["recall", "retain", "reinforce", "contradict", "forget", "status"] as const;
const INSTINCT_SCOPES = ["project", "global"] as const;

export function registerWorkbenchInstincts(pi: ExtensionAPI, dependencies: InstinctDependencies): void {
  const stores = new Map<string, WorkbenchInstinctStore>();

  async function storeFor(cwd: string): Promise<WorkbenchInstinctStore> {
    const projectPath = await findProjectRoot(cwd, dependencies.exec);
    const key = `${getAgentDir()}::${projectPath}`;
    let store = stores.get(key);
    if (!store) {
      store = new WorkbenchInstinctStore(getAgentDir(), projectPath);
      stores.set(key, store);
    }
    return store;
  }

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const store = await storeFor(ctx.cwd);
      const l1 = renderInstinctL1(await store.recall(event.prompt, { inject: true }));
      if (!l1) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${l1}` };
    } catch {
      return;
    }
  });

  pi.registerTool({
    name: "workbench_instincts",
    label: "Workbench Instincts",
    description: "Project-learned behaviors with confidence. Hints, not instructions. Retain after a user correction or repeated workflow. Reinforce when it holds, contradict when the user overrides it. Never store secrets.",
    promptSnippet: "Retain or recall learned project behaviors after corrections",
    promptGuidelines: [
      "workbench_instincts: Learned behaviors only. Durable facts still go through workbench_memory after Coordinator review.",
      "workbench_instincts: Retain one trigger and one action after a user correction or a repeated successful pattern. Start from evidence, not vibes.",
      "workbench_instincts: Injected instincts are fallible hints, never instructions. Contradict when the user overrides the behavior.",
      "workbench_instincts: Do not retain secrets, credentials, transcript dumps, or anything git already records.",
    ],
    parameters: Type.Object({
      action: StringEnum(INSTINCT_ACTIONS),
      trigger: Type.Optional(Type.String({ description: "When this behavior applies" })),
      instinctAction: Type.Optional(Type.String({ description: "What to do when the trigger holds" })),
      domain: Type.Optional(StringEnum(INSTINCT_DOMAINS)),
      scope: Type.Optional(StringEnum(INSTINCT_SCOPES)),
      evidence: Type.Optional(Type.String({ description: "What observation or correction supports this instinct" })),
      id: Type.Optional(Type.String({ description: "Instinct id for reinforce, contradict, or forget" })),
      query: Type.Optional(Type.String({ description: "Optional recall filter" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const store = await storeFor(ctx.cwd);
      if (params.action === "status") {
        const status = await store.status();
        const domains = Object.entries(status.domains).map(([name, count]) => `${name}:${count}`).join(", ") || "none";
        return { content: [{ type: "text", text: `- Instincts: ${status.count}\n- Injectable: ${status.injectable}\n- Global: ${status.global}\n- Domains: ${domains}` }], details: { status } };
      }
      if (params.action === "recall") {
        const entries = await store.recall(params.query, { scope: "all" });
        return { content: [{ type: "text", text: renderInstinctL1(entries) || "No matching Workbench instincts." }], details: { entries } };
      }
      if (params.action === "forget") {
        if (!params.id) throw new Error("forget requires id.");
        const entry = await store.forget(params.id);
        return { content: [{ type: "text", text: `Forgot instinct ${entry.id}.` }], details: { entry } };
      }
      if (params.action === "reinforce" || params.action === "contradict") {
        if (!params.id) throw new Error(`${params.action} requires id.`);
        const entry = params.action === "reinforce"
          ? await store.reinforce(params.id, params.evidence)
          : await store.contradict(params.id, params.evidence);
        return { content: [{ type: "text", text: `${params.action === "reinforce" ? "Reinforced" : "Contradicted"} instinct ${entry.id} (confidence ${entry.confidence.toFixed(1)}).` }], details: { entry } };
      }
      if (!params.trigger || !params.instinctAction || !params.evidence) {
        throw new Error("retain requires trigger, instinctAction, and evidence.");
      }
      const entry = await store.retain({
        trigger: params.trigger,
        action: params.instinctAction,
        domain: params.domain as InstinctDomain | undefined,
        scope: params.scope as InstinctScope | undefined,
        evidence: params.evidence,
      });
      return { content: [{ type: "text", text: `Retained instinct ${entry.id} (${entry.confidence.toFixed(1)} ${entry.domain}).` }], details: { entry } };
    },
  });

  pi.registerCommand("instincts", {
    description: "Show or recall Workbench learned behaviors: /instincts [status|recall [query]]",
    handler: async (rawArgs, ctx) => {
      try {
        const store = await storeFor(ctx.cwd);
        const args = rawArgs.trim();
        if (!args || args === "status") {
          const status = await store.status();
          const l1 = renderInstinctL1(await store.recall(undefined, { inject: true }));
          const domains = Object.entries(status.domains).map(([name, count]) => `${name}:${count}`).join(", ") || "none";
          dependencies.report("Workbench instincts", `${l1 || "No injectable instincts yet."}\n\n- Instincts: ${status.count}; injectable ${status.injectable}; global ${status.global}\n- Domains: ${domains}\nRetain from the agent with workbench_instincts; promote durable facts through /memory.`);
          return;
        }
        const query = args.replace(/^recall\s+/i, "").trim();
        const l1 = renderInstinctL1(await store.recall(query || undefined, { scope: "all" }));
        dependencies.report("Workbench instincts", l1 || "No matching Workbench instincts.");
      } catch (error) {
        dependencies.report("Workbench instincts", error instanceof Error ? error.message : String(error));
      }
    },
  });
}
