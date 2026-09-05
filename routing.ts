export type RoutingEffort = "auto" | "light" | "standard" | "heavy";
export type ResolvedRoutingEffort = Exclude<RoutingEffort, "auto">;
export type RoutingPolicy = "balanced" | "economy" | "quality" | "fixed";
export type RoutingFamily = "codex" | "grok";
export type RoutingThinking = "low" | "medium" | "high";

export interface RoutingSignals {
  complexity: 0 | 1 | 2;
  uncertainty: 0 | 1 | 2;
  risk: 0 | 1 | 2;
  breadth: 0 | 1 | 2;
  verificationCost: 0 | 1 | 2;
}

export interface ReadOnlyBudget {
  turns: number;
  tools: number;
}

export interface FixedModelRoute {
  model: string;
  thinking: RoutingThinking;
}

export interface ModelRoutingState {
  policy: RoutingPolicy;
  family?: RoutingFamily;
  fixed?: FixedModelRoute;
}

export interface RoutingRequest {
  task: string;
  role?: string;
  effort?: RoutingEffort;
  policy?: ModelRoutingState;
  readOnly?: boolean;
  visual?: boolean;
  model?: string;
}

export interface ModelRoute {
  effort: ResolvedRoutingEffort;
  model: string;
  thinking: RoutingThinking;
  policy: RoutingPolicy;
  reason: string;
  budget?: ReadOnlyBudget;
  effectiveLimits?: { turns?: number; tools?: number };
  signals: RoutingSignals;
}

export const BALANCED_ROUTING_STATE: ModelRoutingState = { policy: "balanced" };

export const BALANCED_ROUTES: Record<ResolvedRoutingEffort, FixedModelRoute> = {
  light: { model: "openai-codex/gpt-5.6-luna:low", thinking: "low" },
  standard: { model: "openai-codex/gpt-5.6-terra:medium", thinking: "medium" },
  heavy: { model: "openai-codex/gpt-5.6-sol:high", thinking: "high" },
};

export const GROK_PRIMARY_ROUTE: FixedModelRoute = {
  model: "xai/grok-4.6:high",
  thinking: "high",
};

export const GROK_BALANCED_ROUTES: Record<ResolvedRoutingEffort, FixedModelRoute> = {
  light: { model: "xai/grok-4.6:low", thinking: "low" },
  standard: { model: "xai/grok-4.6:medium", thinking: "medium" },
  heavy: GROK_PRIMARY_ROUTE,
};

export const ROUTING_MODEL_ALIASES: Record<string, FixedModelRoute> = {
  spark: { model: "openai-codex/gpt-5.3-codex-spark:low", thinking: "low" },
  luna: BALANCED_ROUTES.light,
  terra: BALANCED_ROUTES.standard,
  sol: BALANCED_ROUTES.heavy,
  grok: GROK_PRIMARY_ROUTE,
};

export const READ_ONLY_BUDGETS: Record<ResolvedRoutingEffort, ReadOnlyBudget> = {
  light: { turns: 8, tools: 30 },
  standard: { turns: 16, tools: 60 },
  heavy: { turns: 30, tools: 120 },
};

const POLICY_ROUTES: Record<Exclude<RoutingPolicy, "fixed">, Record<ResolvedRoutingEffort, FixedModelRoute>> = {
  balanced: BALANCED_ROUTES,
  economy: {
    light: BALANCED_ROUTES.light,
    standard: { model: "openai-codex/gpt-5.3-codex-spark:medium", thinking: "medium" },
    heavy: BALANCED_ROUTES.standard,
  },
  quality: {
    light: BALANCED_ROUTES.standard,
    standard: BALANCED_ROUTES.heavy,
    heavy: BALANCED_ROUTES.heavy,
  },
};

const GROK_POLICY_ROUTES: Record<Exclude<RoutingPolicy, "fixed">, Record<ResolvedRoutingEffort, FixedModelRoute>> = {
  balanced: GROK_BALANCED_ROUTES,
  economy: {
    light: GROK_BALANCED_ROUTES.light,
    standard: GROK_BALANCED_ROUTES.light,
    heavy: GROK_BALANCED_ROUTES.standard,
  },
  quality: {
    light: GROK_BALANCED_ROUTES.standard,
    standard: GROK_BALANCED_ROUTES.heavy,
    heavy: GROK_BALANCED_ROUTES.heavy,
  },
};

const VISUAL_PATTERN = /\b(image|images|photo|photograph|screenshot|vision|visual|canvas|diagram|mockup|figma|svg|video|animation|motion|frontend|render(?:ing|ed)?|screen|layout|ui|user interface|css|compose)\b/i;

function signal(text: string, medium: RegExp, high: RegExp): 0 | 1 | 2 {
  if (high.test(text)) return 2;
  if (medium.test(text)) return 1;
  return 0;
}

export function classifyRoutingSignals(task: string, role = ""): RoutingSignals {
  const text = `${task}\n${role}`;
  const roleUncertainty = /technical-reviewer|oracle|planner|requirements-analyst/i.test(role) ? 1 : 0;
  const roleVerification = /quality-reviewer|reviewer|implementer|worker/i.test(role) ? 1 : 0;
  return {
    complexity: signal(
      text,
      /\b(implement|refactor|debug|diagnose|design|integration|multiple|workflow)\b/i,
      /\b(hard|complex|architecture|concurrency|distributed|race condition|root cause|migration|end-to-end)\b/i,
    ),
    uncertainty: Math.max(
      roleUncertainty,
      signal(text, /\b(investigate|explore|unknown|unclear|research|recon|scout)\b/i, /\b(ambiguous|novel|unfamiliar|root cause|second opinion)\b/i),
    ) as 0 | 1 | 2,
    risk: signal(
      text,
      /\b(api|database|state|production|reliability|compatibility|breaking)\b/i,
      /\b(security|authentication|authorization|credential|destructive|data loss|payment|privacy|migration)\b/i,
    ),
    breadth: signal(text, /\b(several|multiple|cross-file|module|package)\b/i, /\b(cross-cutting|repository-wide|monorepo|across services|system-wide)\b/i),
    verificationCost: Math.max(
      roleVerification,
      signal(text, /\b(test|verify|review|typecheck|build)\b/i, /\b(integration test|end-to-end|e2e|full suite|independent verification)\b/i),
    ) as 0 | 1 | 2,
  };
}

export function classifyRoutingEffort(task: string, role = ""): { effort: ResolvedRoutingEffort; signals: RoutingSignals } {
  const signals = classifyRoutingSignals(task, role);
  const values = Object.values(signals);
  const score = values.reduce((sum, value) => sum + value, 0);
  const effort: ResolvedRoutingEffort = values.includes(2) || score >= 5
    ? "heavy"
    : score <= 1
      ? "light"
      : "standard";
  return { effort, signals };
}

export function normalizeRoutingPolicy(value: unknown): Exclude<RoutingPolicy, "fixed"> {
  return value === "economy" || value === "quality" || value === "balanced" ? value : "balanced";
}

export function normalizeRoutingFamily(value: unknown): RoutingFamily {
  return value === "grok" ? "grok" : "codex";
}

export function routingFamily(state: ModelRoutingState | undefined): RoutingFamily {
  return state?.family === "grok" ? "grok" : "codex";
}

export function splitModelRoute(model: string, fallbackThinking: RoutingThinking = "medium"): FixedModelRoute {
  const trimmed = model.trim();
  const match = trimmed.match(/:(low|medium|high)$/);
  return {
    model: trimmed || BALANCED_ROUTES.standard.model,
    thinking: (match?.[1] as RoutingThinking | undefined) ?? fallbackThinking,
  };
}

export function parseFixedRoutingModel(value: string): FixedModelRoute | undefined {
  const alias = resolveRoutingModelAlias(value);
  if (alias) return { ...alias };
  const match = value.trim().match(/^(openai-codex|xai)\/([A-Za-z0-9._-]+)(?::(low|medium|high))?$/);
  if (!match) return undefined;
  const thinking = (match[3] as RoutingThinking | undefined) ?? "medium";
  return { model: `${match[1]}/${match[2]}:${thinking}`, thinking };
}

export function parseDelegationModel(value: string): FixedModelRoute {
  const match = value.trim().match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9][A-Za-z0-9._/-]*)(?::(low|medium|high))?$/);
  if (!match) throw new Error("Use an exact provider/model[:low|medium|high] for a delegation model override.");
  const thinking = (match[3] ?? "medium") as RoutingThinking;
  return { model: `${match[1]}/${match[2]}:${thinking}`, thinking };
}

export function routeTask(request: RoutingRequest): ModelRoute {
  const classified = classifyRoutingEffort(request.task, request.role);
  let effort = request.effort && request.effort !== "auto" ? request.effort : classified.effort;
  const visual = request.visual ?? VISUAL_PATTERN.test(request.task);
  const policy = request.policy ?? BALANCED_ROUTING_STATE;
  const policyName = policy.policy === "fixed" && policy.fixed ? "fixed" : policy.policy === "fixed" ? "balanced" : policy.policy;
  const family = routingFamily(policy);
  const table = family === "grok" ? GROK_POLICY_ROUTES : POLICY_ROUTES;
  let selected = request.model !== undefined ? parseDelegationModel(request.model) : policyName === "fixed"
    ? policy.fixed!
    : table[policyName][effort];

  if (visual && /codex-spark/i.test(selected.model)) {
    if (request.model !== undefined) throw new Error("The requested Spark model is not allowed for visual work; choose another exact model. No substitution was made.");
    selected = BALANCED_ROUTES.standard;
    if (effort === "light") effort = "standard";
  }

  const dimensions = Object.entries(classified.signals)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`));
  const basis = request.effort && request.effort !== "auto"
    ? `parent chose ${request.effort}`
    : dimensions.length
      ? `${dimensions.join(" + ")} signals`
      : "bounded low-risk task";
  const reason = request.model !== undefined ? `explicit per-delegation model; ${basis}` : policyName === "fixed"
    ? `fixed session override; ${basis}`
    : `${family === "grok" ? "grok " : ""}${policyName} policy; ${basis}${visual ? "; visual work avoids Spark" : ""}`;

  return {
    effort,
    model: selected.model,
    thinking: selected.thinking,
    policy: request.model !== undefined ? "fixed" : policyName,
    reason,
    budget: request.readOnly ? READ_ONLY_BUDGETS[effort] : undefined,
    signals: classified.signals,
  };
}

export function formatRoutingReceipt(role: string, route: ModelRoute): string {
  const limits = route.effectiveLimits ?? route.budget;
  const limitParts = [
    limits?.turns !== undefined ? `${limits.turns} turns` : undefined,
    limits?.tools !== undefined ? `${limits.tools} tools` : undefined,
  ].filter((value): value is string => Boolean(value));
  const budget = limitParts.length ? `; effective read-only limit ${limitParts.join("/")}` : "; mutation-capable or mixed workflow is not hard-capped";
  const model = route.model.replace(/:(?:low|medium|high)$/, "");
  return `${role} → ${model} · ${route.thinking} — ${route.reason}${budget}`;
}

export function readOnlyBudgetGuidance(route: ModelRoute): string {
  if (!route.budget) return "";
  return `[Read-only work budget: ${route.budget.turns} assistant turns and ${route.budget.tools} tool calls. Stop exploring when the answer is supported; before the budget is exhausted, synthesize the best evidence, unresolved uncertainty, and exact next verification step. Do not trade correctness for filling the budget.]`;
}

export function isNativeReadOnlyAgent(agent: unknown): boolean {
  return typeof agent === "string" && /^(scout|researcher|reviewer|oracle)$/i.test(agent.trim());
}

export interface NativeFallbackResult {
  input: Record<string, unknown>;
  route: ModelRoute;
  changed: string[];
}

/** Applies only top-level safe defaults. workflowScript remains opaque and is never parsed or rewritten. */
export function nativeSubagentFallback(
  input: Record<string, unknown>,
  state: ModelRoutingState = BALANCED_ROUTING_STATE,
): NativeFallbackResult {
  const next = { ...input };
  const route = routeTask({
    task: typeof input.task === "string" ? input.task : "Delegated subagent workflow",
    role: typeof input.agent === "string" ? input.agent : "workflow child",
    effort: input.workflowScript === undefined ? "auto" : "standard",
    policy: state,
    readOnly: isNativeReadOnlyAgent(input.agent),
  });
  const changed: string[] = [];
  const explicitThinking = input.thinking === "low" || input.thinking === "medium" || input.thinking === "high"
    ? input.thinking
    : undefined;
  if (input.model === undefined) {
    next.model = explicitThinking ? route.model.replace(/:(?:low|medium|high)$/, `:${explicitThinking}`) : route.model;
    changed.push("model");
  }
  if (input.thinking === undefined) {
    next.thinking = typeof input.model === "string"
      ? splitModelRoute(input.model, route.thinking).thinking
      : route.thinking;
    changed.push("thinking");
  }
  if (route.budget && input.workflowScript === undefined) {
    if (input.turnBudget === undefined) {
      next.turnBudget = { maxTurns: route.budget.turns, graceTurns: 1 };
      changed.push("turnBudget");
    }
    if (input.toolBudget === undefined) {
      next.toolBudget = { soft: Math.max(1, route.budget.tools - 5), hard: route.budget.tools };
      changed.push("toolBudget");
    }
  }
  const actualThinking = next.thinking === "low" || next.thinking === "medium" || next.thinking === "high"
    ? next.thinking
    : route.thinking;
  const turnLimit = typeof next.turnBudget === "object" && next.turnBudget !== null
    && typeof (next.turnBudget as { maxTurns?: unknown }).maxTurns === "number"
    ? (next.turnBudget as { maxTurns: number }).maxTurns
    : undefined;
  const toolLimit = typeof next.toolBudget === "object" && next.toolBudget !== null
    && typeof (next.toolBudget as { hard?: unknown }).hard === "number"
    ? (next.toolBudget as { hard: number }).hard
    : undefined;
  const actualRoute = {
    ...route,
    model: typeof next.model === "string" ? next.model : route.model,
    thinking: actualThinking,
    ...((turnLimit !== undefined || toolLimit !== undefined)
      ? { effectiveLimits: { ...(turnLimit !== undefined ? { turns: turnLimit } : {}), ...(toolLimit !== undefined ? { tools: toolLimit } : {}) } }
      : {}),
  };
  return { input: next, route: actualRoute, changed };
}

export function resolveRoutingModelAlias(value: string): FixedModelRoute | undefined {
  return ROUTING_MODEL_ALIASES[value.trim().toLowerCase()];
}

export type SessionRoutingDirective =
  | { kind: "fixed"; fixed: FixedModelRoute }
  | { kind: "family"; family: RoutingFamily }
  | { kind: "policy"; policy: Exclude<RoutingPolicy, "fixed"> };

export function parseSessionRoutingDirective(text: string): SessionRoutingDirective | undefined {
  const normalized = text.trim().toLowerCase().replace(/[.!]$/, "");
  const fixed = normalized.match(/^(?:please )?use (spark|luna|terra|sol|grok) for everything(?: this session)?$/);
  if (fixed) return { kind: "fixed", fixed: resolveRoutingModelAlias(fixed[1])! };
  const family = normalized.match(/^(?:please )?use (codex|grok) routing(?: this session)?$/);
  if (family) return { kind: "family", family: family[1] === "grok" ? "grok" : "codex" };
  const policy = normalized.match(/^(?:please )?use (balanced|economy|quality) routing(?: this session)?$/);
  return policy ? { kind: "policy", policy: policy[1] as Exclude<RoutingPolicy, "fixed"> } : undefined;
}
