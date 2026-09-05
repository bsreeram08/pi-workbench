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
  routingFamily,
  type ModelRoutingState,
  type RoutingFamily,
  type SessionRoutingDirective,
} from "./routing.ts";
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
      family: normalizeRoutingFamily(parsed.modelRoutingFamily),
    };
  } catch {
    return { policy: "balanced", family: "codex" };
  }
}

export function writeDurableRouting(cwd: string, patch: Partial<DurableRoutingDefaults>): string {
  const configPath = projectConfigPath(findProjectRootSync(cwd));
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Workbench routing config is malformed.");
    current = parsed as Record<string, unknown>;
  } else {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
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
  if (state.policy === "fixed" && state.fixed) {
    return `Fixed child route for this session: \`${state.fixed.model}\` (${state.fixed.thinking}). Main Pi keeps its current model; the session override changes delegated children only. To override the parent temporarily, launch it with \`pi --model ${state.fixed.model.replace(/:(?:low|medium|high)$/, "")} --thinking ${state.fixed.thinking}\`.`;
  }
  const family = routingFamily(state) === "grok"
    ? " Grok 4.6 family: light/standard/heavy use xai/grok-4.6 at low/medium/high thinking."
    : " Codex family: Luna/low, Terra/medium, and Sol/high.";
  return `${state.policy[0].toUpperCase()}${state.policy.slice(1)} adaptive routing is active.${family} New sessions use the durable project family and policy. Persist with --default; session commands stay session-only.`;
}

function nativeRoutingGuidance(state: ModelRoutingState): string {
  const fixed = state.policy === "fixed" && state.fixed
    ? ` Fixed mode is active: use ${state.fixed.model} with ${state.fixed.thinking} thinking as every workflow default unless a delegation explicitly selects another model. Main Pi keeps its current model; fixed mode changes delegated children only.`
    : "";
  const family = routingFamily(state);
  const routes = family === "grok" ? GROK_BALANCED_ROUTES : BALANCED_ROUTES;
  const overrideNote = " Honor explicit per-task model requests using the model parameter on delegate_task, workbench_agent_start, or workbench_plan review: for example openai-codex/gpt-6-astra:high. This overrides session defaults for the call only; unavailable exact models fail without substitution. Effort controls the budget separately.";
  const familyNote = overrideNote + (family === "grok"
    ? " Grok 4.6 family is active for delegated children. `/model-routing grok` is session-only; `/model-routing grok --default` writes the durable project family. Main Pi keeps its current model unless launched with --model."
    : " Codex family is the shipped default. `/model-routing grok` switches children for this session; `/model-routing grok --default` persists Grok 4.6 for new sessions.");
  return `Adaptive delegation routing: prefer first-party delegate_task for ordinary specialist work and workbench_agent_start when a persistent read-only agent must remain steerable or may ask the parent a question. Classify each lane independently from complexity, uncertainty, risk, breadth, and verification cost; role is only a prior. Balanced routes are light=${routes.light.model}, standard=${routes.standard.model}, heavy=${routes.heavy.model}. A hard scout/recon lane can and should reach Sol or Grok 4.6 high; never use Spark for image/visual work. Before launch, show one compact line with role, model/thinking, reason, and read-only budget. Read-only limits are 8 turns/30 tools (light), 16/60 (standard), or 30/120 (heavy), with stop-and-synthesize guidance. Persistent mutation-capable agents are not enabled; use the existing single-writer delegate_task path under its lease. Do not use the external subagent tool or workflowScript; first-party Workbench agents are the runtime.${familyNote}${fixed}`;
}

export function registerModelRouting(
  pi: ExtensionAPI,
  report?: (title: string, body: string) => void,
): ModelRoutingController {
  let state: ModelRoutingState = { ...BALANCED_ROUTING_STATE };
  let durableDefaults: DurableRoutingDefaults = { policy: "balanced", family: "codex" };

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

  const showState = (ctx: ExtensionContext): void => {
    const body = `${stateDescription(state)}\n\n- \`/model-routing\`: interactive customize menu in the TUI\n- \`balanced\` / \`economy\` / \`quality\`: adaptive child routing in the active family\n- \`codex\` / \`grok\`: session family; add \`--default\` to persist for new sessions\n- \`fixed <model-or-alias>\`: session-only fixed child route (\`spark\`, \`luna\`, \`terra\`, \`sol\`, \`grok\`, or an available \`openai-codex/<model>\` / \`xai/<model>[:thinking]\`); Main Pi keeps its current model\n- \`reset\`: restore the durable project route (${durableDefaults.family} ${durableDefaults.policy}) for this session`;
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

  const applyAdaptive = (ctx: ExtensionContext, next: ModelRoutingState, makeDefault: boolean): void => {
    if (makeDefault) {
      persistDefault(ctx, {
        policy: next.policy === "fixed" ? durableDefaults.policy : next.policy,
        family: routingFamily(next),
      });
    }
    applyState(ctx, next, true);
    showState(ctx);
  };

  const currentAdaptivePolicy = (): Exclude<ModelRoutingState["policy"], "fixed"> => (
    state.policy === "economy" || state.policy === "quality" || state.policy === "balanced"
      ? state.policy
      : durableDefaults.policy
  );

  const runCustomizeMenu = async (ctx: ExtensionContext): Promise<void> => {
    const familyLabel = await ctx.ui.select("Child model family", [...ROUTING_MENU_FAMILIES]);
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
    applyAdaptive(ctx, durableState({ policy, family }), makeDefault);
  };

  pi.registerCommand("model-routing", {
    description: "Customize child model routing with a menu, session flags, or --default to persist the project family",
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
        applyState(ctx, durableState(durableDefaults), true);
        showState(ctx);
        return;
      }
      if (parsed.kind === "policy") {
        applyAdaptive(ctx, durableState({ policy: parsed.policy, family: routingFamily(state) }), parsed.makeDefault);
        return;
      }
      if (parsed.kind === "family") {
        applyAdaptive(ctx, durableState({ policy: currentAdaptivePolicy(), family: parsed.family }), parsed.makeDefault);
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
    appendReceipt(stateDescription(state));
    return { action: "handled" as const };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${nativeRoutingGuidance(state)}`,
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
