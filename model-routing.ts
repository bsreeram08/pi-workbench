import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  BALANCED_ROUTES,
  BALANCED_ROUTING_STATE,
  GROK_BALANCED_ROUTES,
  normalizeRoutingFamily,
  normalizeRoutingPolicy,
  parseFixedRoutingModel,
  parseSessionRoutingDirective,
  parentRouteForState,
  routingFamily,
  type ModelRoutingState,
  type RoutingFamily,
  type SessionRoutingDirective,
} from "./routing.ts";
import { WORKBENCH_OPERATING_CONTRACT } from "./operating-contract.ts";
import { findProjectRootSync } from "./project.ts";

export const MODEL_ROUTING_ENTRY = "pi-workbench-model-routing";
export const MODEL_ROUTING_RECEIPT_ENTRY = "pi-workbench-model-routing-receipt";

interface StoredRoutingState {
  version: 1;
  state: ModelRoutingState;
}

export interface ModelRoutingController {
  getState(): ModelRoutingState;
  status(): string;
}

function cloneState(state: ModelRoutingState): ModelRoutingState {
  const next: ModelRoutingState = { policy: state.policy };
  if (state.family === "grok") next.family = "grok";
  if (state.fixed) next.fixed = { ...state.fixed };
  return next;
}

export function restoreModelRoutingState(value: unknown): ModelRoutingState {
  if (!value || typeof value !== "object") return { ...BALANCED_ROUTING_STATE };
  const stored = value as Partial<StoredRoutingState>;
  if (stored.version !== 1 || !stored.state || typeof stored.state !== "object") return { ...BALANCED_ROUTING_STATE };
  const family = stored.state.family === "grok" ? "grok" as const : undefined;
  if (stored.state.policy === "fixed" && stored.state.fixed && typeof stored.state.fixed.model === "string") {
    const parsed = parseFixedRoutingModel(stored.state.fixed.model);
    if (parsed && parsed.model === stored.state.fixed.model && parsed.thinking === stored.state.fixed.thinking) {
      return family ? { policy: "fixed", family, fixed: parsed } : { policy: "fixed", fixed: parsed };
    }
  }
  return family
    ? { policy: normalizeRoutingPolicy(stored.state.policy), family }
    : { policy: normalizeRoutingPolicy(stored.state.policy) };
}

export interface DurableRoutingDefaults {
  policy: Exclude<ModelRoutingState["policy"], "fixed">;
  family: RoutingFamily;
}

const USAGE = "Usage: /model-routing [status|balanced|economy|quality|codex|grok|fixed <spark|luna|terra|sol|grok|openai-codex/model|xai/model[:low|medium|high]>|reset] [--default]";

export type ParsedModelRoutingCommand =
  | { kind: "open" }
  | { kind: "status" }
  | { kind: "menu" }
  | { kind: "reset" }
  | { kind: "policy"; policy: Exclude<ModelRoutingState["policy"], "fixed">; makeDefault: boolean }
  | { kind: "family"; family: RoutingFamily; makeDefault: boolean }
  | { kind: "fixed"; value: string }
  | { kind: "usage"; message: string };

function splitDefaultFlag(raw: string): { makeDefault: boolean; rest: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let makeDefault = false;
  for (const token of tokens) {
    if (token.toLowerCase() === "--default") makeDefault = true;
    else rest.push(token);
  }
  return { makeDefault, rest: rest.join(" ") };
}

export const ROUTING_MENU_FAMILIES = [
  "Codex (Luna/Terra/Sol)",
  "Grok 4.6 (low/medium/high)",
] as const;
export const ROUTING_MENU_POLICIES = ["Balanced", "Economy", "Quality"] as const;
export const ROUTING_MENU_SCOPES = ["This session only", "Save as project default"] as const;

export function parseRoutingMenuFamily(label: string): RoutingFamily | undefined {
  if (label.startsWith("Codex")) return "codex";
  if (label.startsWith("Grok")) return "grok";
  return undefined;
}

export function parseRoutingMenuPolicy(label: string): Exclude<ModelRoutingState["policy"], "fixed"> | undefined {
  const value = label.trim().toLowerCase();
  return value === "balanced" || value === "economy" || value === "quality" ? value : undefined;
}

export function parseRoutingMenuScope(label: string): boolean | undefined {
  if (label === "This session only") return false;
  if (label === "Save as project default") return true;
  return undefined;
}

export function parseModelRoutingCommand(raw: string): ParsedModelRoutingCommand {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "open" };
  const { makeDefault, rest } = splitDefaultFlag(trimmed);
  const normalized = rest.toLowerCase();
  if (!normalized) return { kind: "usage", message: USAGE };
  if (normalized === "status") {
    if (makeDefault) return { kind: "usage", message: USAGE };
    return { kind: "status" };
  }
  if (normalized === "menu") {
    if (makeDefault) return { kind: "usage", message: USAGE };
    return { kind: "menu" };
  }
  if (normalized === "reset") {
    if (makeDefault) return { kind: "usage", message: "`reset` restores the durable default; it does not take --default." };
    return { kind: "reset" };
  }
  if (normalized === "balanced" || normalized === "economy" || normalized === "quality") {
    return { kind: "policy", policy: normalized, makeDefault };
  }
  if (normalized === "grok" || normalized === "codex" || normalized === "family grok" || normalized === "family codex") {
    return { kind: "family", family: normalized.endsWith("grok") ? "grok" : "codex", makeDefault };
  }
  const fixed = rest.match(/^fixed\s+(.+)$/i)?.[1]?.trim();
  if (fixed) {
    if (makeDefault) return { kind: "usage", message: "Fixed routes are session-only. Use `/model-routing grok --default` or `/model-routing codex --default` for a durable family." };
    return { kind: "fixed", value: fixed };
  }
  return { kind: "usage", message: USAGE };
}

function projectConfigPath(root: string): string {
  return path.join(root, ".pi", "pi-workbench", "config.json");
}

export function mergeSessionRoutingDirective(
  current: ModelRoutingState,
  durable: DurableRoutingDefaults,
  directive: SessionRoutingDirective,
): ModelRoutingState {
  if (directive.kind === "fixed") return { policy: "fixed", fixed: directive.fixed };
  const policy = current.policy === "economy" || current.policy === "quality" || current.policy === "balanced"
    ? current.policy
    : durable.policy;
  const family = routingFamily(current);
  if (directive.kind === "family") return durableState({ policy, family: directive.family });
  return durableState({ policy: directive.policy, family });
}

export function readDurableRouting(cwd: string): DurableRoutingDefaults {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectConfigPath(findProjectRootSync(cwd)), "utf8")) as {
      modelRoutingPolicy?: unknown;
      modelRoutingFamily?: unknown;
    };
    return {
      policy: normalizeRoutingPolicy(parsed.modelRoutingPolicy),
      family: parsed.modelRoutingFamily === undefined
        ? "grok"
        : normalizeRoutingFamily(parsed.modelRoutingFamily),
    };
  } catch {
    return { policy: "balanced", family: "grok" };
  }
}

function assertSafeRoutingConfigPath(root: string, configPath: string): void {
  const resolvedRoot = path.resolve(root);
  const expected = path.join(resolvedRoot, ".pi", "pi-workbench", "config.json");
  if (path.resolve(configPath) !== expected) throw new Error("Workbench routing config path is invalid.");
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe project root.");
  let current = resolvedRoot;
  for (const component of [".pi", "pi-workbench"]) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe project state directory: ${current}`);
  }
  if (fs.existsSync(expected)) {
    const stat = fs.lstatSync(expected);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Unsafe Workbench routing config.");
  }
}

export function writeDurableRouting(cwd: string, patch: Partial<DurableRoutingDefaults>): string {
  const root = findProjectRootSync(cwd);
  const configPath = projectConfigPath(root);
  assertSafeRoutingConfigPath(root, configPath);
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Workbench routing config is malformed.");
    current = parsed as Record<string, unknown>;
  }
  if (patch.policy) current.modelRoutingPolicy = patch.policy;
  if (patch.family) current.modelRoutingFamily = patch.family;
  fs.writeFileSync(configPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return configPath;
}

function durableState(defaults: DurableRoutingDefaults): ModelRoutingState {
  return defaults.family === "grok" ? { policy: defaults.policy, family: "grok" } : { policy: defaults.policy };
}

function fixedRouteIsAvailable(ctx: ExtensionContext, state: ModelRoutingState): boolean {
  if (state.policy !== "fixed" || !state.fixed) return true;
  const bareModel = state.fixed.model.replace(/:(?:low|medium|high)$/, "");
  const slash = bareModel.indexOf("/");
  if (slash <= 0) return false;
  const provider = bareModel.slice(0, slash);
  const modelId = bareModel.slice(slash + 1);
  if ((provider !== "openai-codex" && provider !== "xai") || !modelId) return false;
  try {
    return Boolean(ctx.modelRegistry.find(provider, modelId));
  } catch {
    return false;
  }
}

function stateLabel(state: ModelRoutingState): string {
  if (state.policy === "fixed" && state.fixed) {
    const shortModel = state.fixed.model.replace(/^openai-codex\//, "");
    return `fixed:${shortModel}`;
  }
  return routingFamily(state) === "grok" ? `grok:${state.policy}` : state.policy;
}

function stateDescription(state: ModelRoutingState): string {
  const parent = parentRouteForState(state);
  const parentLine = ` Main Pi is ${parent.provider}/${parent.id} (${parent.thinking}).`;
  if (state.policy === "fixed" && state.fixed) {
    return `Fixed route for this session: \`${state.fixed.model}\` (${state.fixed.thinking}).${parentLine} Family and fixed routes move Main Pi and children together.`;
  }
  const family = routingFamily(state) === "grok"
    ? " Grok 4.6 family: light/standard/heavy use xai/grok-4.6 at low/medium/high thinking."
    : " Codex family: Luna/low, Terra/medium, and Sol/high.";
  return `${state.policy[0].toUpperCase()}${state.policy.slice(1)} adaptive routing is active.${family}${parentLine} Persist with --default so new sessions in this project follow.`;
}

function nativeRoutingGuidance(state: ModelRoutingState): string {
  const parent = parentRouteForState(state);
  const fixed = state.policy === "fixed" && state.fixed
    ? ` Fixed mode is active: use ${state.fixed.model} with ${state.fixed.thinking} thinking as every workflow default unless a delegation explicitly selects another model.`
    : "";
  const family = routingFamily(state);
  const routes = family === "grok" ? GROK_BALANCED_ROUTES : BALANCED_ROUTES;
  const overrideNote = " Honor an explicit model=provider/model[:thinking] the user asked for on delegate_task, workbench_agent_start, or workbench_plan review. This overrides session defaults for that call only; unavailable exact models fail without substitution. Do not invent openai-codex/gpt-6-astra or any other model the user did not request. Effort controls the budget separately.";
  const familyNote = overrideNote + (family === "grok"
    ? ` Grok 4.6 family is active. Main Pi is ${parent.provider}/${parent.id}:${parent.thinking}. \`/model-routing grok\` moves Main Pi and children; \`/model-routing grok --default\` writes the durable project family.`
    : ` Codex family is active. Main Pi is ${parent.provider}/${parent.id}:${parent.thinking}. \`/model-routing grok\` moves Main Pi and children to Grok 4.6; \`--default\` persists the project family.`);
  return `Adaptive delegation routing: prefer first-party delegate_task for ordinary specialist work and workbench_agent_start when a persistent read-only agent must remain steerable or may ask the parent a question. Classify each lane independently from complexity, uncertainty, risk, breadth, and verification cost; role is only a prior. Balanced routes are light=${routes.light.model}, standard=${routes.standard.model}, heavy=${routes.heavy.model}. A hard scout/recon lane can and should reach Sol or Grok 4.6 high; never use Spark for image/visual work. Before launch, show one compact line with role, model/thinking, reason, and read-only budget. Read-only limits are 8 turns/30 tools (light), 16/60 (standard), or 30/120 (heavy), with stop-and-synthesize guidance. Persistent mutation-capable agents are not enabled; use the existing single-writer delegate_task path under its lease. Do not use the external subagent tool or workflowScript; first-party Workbench agents are the runtime.${familyNote}${fixed}`;
}

export function registerModelRouting(
  pi: ExtensionAPI,
  report?: (title: string, body: string) => void,
): ModelRoutingController {
  let state: ModelRoutingState = { policy: "balanced", family: "grok" };
  let durableDefaults: DurableRoutingDefaults = { policy: "balanced", family: "grok" };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) ctx.ui.setStatus("model-routing", `route:${stateLabel(state)}`);
  };

  const appendReceipt = (content: string): void => {
    pi.appendEntry(MODEL_ROUTING_RECEIPT_ENTRY, { content });
  };

  pi.registerEntryRenderer(MODEL_ROUTING_RECEIPT_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { content?: unknown };
    const content = typeof data.content === "string" ? data.content : "Model routing updated.";
    return new Text(theme.fg("muted", content), 0, 0);
  });

  const applyState = (ctx: ExtensionContext, next: ModelRoutingState, persist: boolean): void => {
    state = cloneState(next);
    if (persist) pi.appendEntry<StoredRoutingState>(MODEL_ROUTING_ENTRY, { version: 1, state });
    updateStatus(ctx);
  };

  const applyParentModel = async (ctx: ExtensionContext, next: ModelRoutingState): Promise<void> => {
    const route = parentRouteForState(next);
    const target = `${route.provider}/${route.id}`;
    const warn = (message: string): void => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    };
    let model: unknown;
    try {
      model = ctx.modelRegistry.find(route.provider, route.id);
    } catch (error) {
      warn(`Could not switch Main Pi to ${target}: ${error instanceof Error ? error.message : String(error)}. Parent is unchanged.`);
      return;
    }
    if (!model) {
      warn(`Could not switch Main Pi to ${target}; that model is not in Pi's registry. Parent is unchanged.`);
      return;
    }
    if (typeof pi.setModel !== "function") {
      warn(`Could not switch Main Pi to ${target}; this Pi build cannot set the parent model.`);
      return;
    }
    const applied = await pi.setModel(model as never);
    if (applied === false) {
      warn(`Could not switch Main Pi to ${target}. Parent is unchanged. Use Pi /login if that provider has no credential.`);
      return;
    }
    if (typeof pi.setThinkingLevel === "function") pi.setThinkingLevel(route.thinking);
  };

  const showState = (ctx: ExtensionContext): void => {
    const body = `${stateDescription(state)}\n\n- \`/model-routing\`: interactive customize menu in the TUI\n- \`balanced\` / \`economy\` / \`quality\`: adaptive child routing in the active family\n- \`codex\` / \`grok\`: move Main Pi and children; add \`--default\` to persist for new sessions in this project\n- \`fixed <model-or-alias>\`: session route for Main Pi and children (\`spark\`, \`luna\`, \`terra\`, \`sol\`, \`grok\`, or an available \`openai-codex/<model>\` / \`xai/<model>[:thinking]\`)\n- \`reset\`: restore the durable project route (${durableDefaults.family} ${durableDefaults.policy}) for this session`;
    if (report) report("Model routing", body);
    else if (ctx.hasUI) ctx.ui.notify(body, "info");
  };

  const persistDefault = (ctx: ExtensionContext, patch: Partial<DurableRoutingDefaults>): void => {
    try {
      writeDurableRouting(ctx.cwd, patch);
      durableDefaults = { ...durableDefaults, ...patch, family: patch.family ?? durableDefaults.family, policy: patch.policy ?? durableDefaults.policy };
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const applyAdaptive = async (ctx: ExtensionContext, next: ModelRoutingState, makeDefault: boolean): Promise<void> => {
    if (makeDefault) {
      persistDefault(ctx, {
        policy: next.policy === "fixed" ? durableDefaults.policy : next.policy,
        family: routingFamily(next),
      });
    }
    applyState(ctx, next, true);
    await applyParentModel(ctx, next);
    showState(ctx);
  };

  const currentAdaptivePolicy = (): Exclude<ModelRoutingState["policy"], "fixed"> => (
    state.policy === "economy" || state.policy === "quality" || state.policy === "balanced"
      ? state.policy
      : durableDefaults.policy
  );

  const runCustomizeMenu = async (ctx: ExtensionContext): Promise<void> => {
    const familyLabel = await ctx.ui.select("Model family (Main Pi and children)", [...ROUTING_MENU_FAMILIES]);
    if (!familyLabel) return;
    const family = parseRoutingMenuFamily(familyLabel);
    if (!family) return;
    const policyLabel = await ctx.ui.select("Routing policy", [...ROUTING_MENU_POLICIES]);
    if (!policyLabel) return;
    const policy = parseRoutingMenuPolicy(policyLabel);
    if (!policy) return;
    const scopeLabel = await ctx.ui.select("Apply this routing preference", [...ROUTING_MENU_SCOPES]);
    if (!scopeLabel) return;
    const makeDefault = parseRoutingMenuScope(scopeLabel);
    if (makeDefault === undefined) return;
    await applyAdaptive(ctx, durableState({ policy, family }), makeDefault);
  };

  pi.registerCommand("model-routing", {
    description: "Set Main Pi and child routing; --default persists the project family",
    handler: async (rawArgs, ctx) => {
      const parsed = parseModelRoutingCommand(rawArgs);
      if (parsed.kind === "open") {
        if (ctx.hasUI) await runCustomizeMenu(ctx);
        else showState(ctx);
        return;
      }
      if (parsed.kind === "menu") {
        if (!ctx.hasUI) {
          showState(ctx);
          return;
        }
        await runCustomizeMenu(ctx);
        return;
      }
      if (parsed.kind === "status") {
        showState(ctx);
        return;
      }
      if (parsed.kind === "reset") {
        const next = durableState(durableDefaults);
        applyState(ctx, next, true);
        await applyParentModel(ctx, next);
        showState(ctx);
        return;
      }
      if (parsed.kind === "policy") {
        await applyAdaptive(ctx, durableState({ policy: parsed.policy, family: routingFamily(state) }), parsed.makeDefault);
        return;
      }
      if (parsed.kind === "family") {
        await applyAdaptive(ctx, durableState({ policy: currentAdaptivePolicy(), family: parsed.family }), parsed.makeDefault);
        return;
      }
      if (parsed.kind === "usage") {
        if (ctx.hasUI) ctx.ui.notify(parsed.message, "warning");
        return;
      }
      const route = parseFixedRoutingModel(parsed.value);
      if (!route) {
        if (ctx.hasUI) ctx.ui.notify("Fixed routes must be a known alias or openai-codex/<model> or xai/<model>[:low|medium|high].", "warning");
        return;
      }
      const next = { policy: "fixed", fixed: route } as const;
      if (!fixedRouteIsAvailable(ctx, next)) {
        if (ctx.hasUI) ctx.ui.notify(`Model ${route.model.replace(/:(?:low|medium|high)$/, "")} is not available in Pi's model registry.`, "warning");
        return;
      }
      applyState(ctx, next, true);
      await applyParentModel(ctx, next);
      showState(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    durableDefaults = readDurableRouting(ctx.cwd);
    state = durableState(durableDefaults);
    const entry = ctx.sessionManager.getBranch()
      .filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === MODEL_ROUTING_ENTRY)
      .pop() as { data?: unknown } | undefined;
    if (entry) {
      const restored = restoreModelRoutingState(entry.data);
      if (fixedRouteIsAvailable(ctx, restored)) state = restored;
      else if (ctx.hasUI) ctx.ui.notify("The saved fixed child route is no longer available; restored the durable adaptive policy.", "warning");
    }
    await applyParentModel(ctx, state);
    updateStatus(ctx);
  });

  pi.on("input", async (event, ctx) => {
    const directive = parseSessionRoutingDirective(event.text);
    if (!directive) return { action: "continue" as const };
    const next = mergeSessionRoutingDirective(state, durableDefaults, directive);
    if (!fixedRouteIsAvailable(ctx, next)) {
      if (ctx.hasUI) ctx.ui.notify("That fixed route is not available in this Pi installation.", "warning");
      return { action: "handled" as const };
    }
    applyState(ctx, next, true);
    await applyParentModel(ctx, next);
    appendReceipt(stateDescription(state));
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${WORKBENCH_OPERATING_CONTRACT}\n\n${nativeRoutingGuidance(state)}`,
  }));

  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent") return;
    appendReceipt("Deprecated: use first-party `delegate_task` or `workbench_agent_start` instead of the external subagent tool. Workbench no longer rewrites subagent calls.");
  });

  return {
    getState: () => cloneState(state),
    status: () => stateLabel(state),
  };
}
