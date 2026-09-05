import type { WorkbenchConfig } from "./config.ts";
import { parseDelegationModel, routeTask, type ModelRoutingState, type RoutingEffort } from "./routing.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSpec } from "./types.ts";

export type WorkflowModelTier = "fast" | "planning" | "deep" | "review";

export const WORKFLOW_AGENT_IDS = [
  "codebase-explorer",
  "researcher",
  "technical-reviewer",
  "requirements-analyst",
  "planner",
  "quality-reviewer",
  "execution-manager",
  "implementer",
  "task-implementer",
] as const;

export type WorkflowAgentId = (typeof WORKFLOW_AGENT_IDS)[number];

export interface WorkflowAgentProfile extends AgentSpec {
  id: WorkflowAgentId;
  tier: WorkflowModelTier;
  contract: string;
}

const WORKFLOW_AGENTS: readonly WorkflowAgentProfile[] = [
  {
    id: "codebase-explorer",
    title: "Codebase Explorer",
    description: "Finds relevant files, symbols, conventions, and execution paths quickly, returning compact evidence rather than broad commentary.",
    triggers: ["find", "where", "codebase", "pattern", "symbol", "flow", "usage", "implementation"],
    readOnly: true,
    allowBash: true,
    tier: "fast",
    contract: "Search broadly, verify every named path, and return the smallest useful map of the codebase. Never propose changes before establishing what exists.",
  },
  {
    id: "researcher",
    title: "Researcher",
    description: "Retrieves project documentation, dependency guidance, and external technical evidence when current sources matter.",
    triggers: ["docs", "documentation", "sdk", "library", "framework", "dependency", "version", "api", "external", "integration"],
    readOnly: true,
    allowBash: true,
    researchTools: true,
    tier: "fast",
    contract: "Prefer primary documentation and repository evidence. Distinguish current sourced facts from inference, and cite paths or URLs for consequential claims.",
  },
  {
    id: "technical-reviewer",
    title: "Technical Reviewer",
    description: "Diagnoses difficult technical problems and evaluates architecture, correctness, reliability, and system-level trade-offs.",
    triggers: ["architecture", "debug", "root cause", "reliability", "concurrency", "performance", "design"],
    readOnly: true,
    allowBash: true,
    tier: "deep",
    contract: "Inspect evidence before advising. Identify the governing constraint, reject accidental complexity, and give a concrete recommendation with risks and verification steps.",
  },
  {
    id: "requirements-analyst",
    title: "Requirements Analyst",
    description: "Finds hidden intent, ambiguity, scope creep, missing acceptance criteria, and assumptions that would make a plan unsafe.",
    triggers: ["requirements", "scope", "ambiguity", "acceptance", "assumption", "plan"],
    readOnly: true,
    tier: "planning",
    contract: "Act before implementation. Surface only gaps that can materially change scope, architecture, behavior, or verification; do not manufacture questions for their own sake.",
  },
  {
    id: "planner",
    title: "Planner",
    description: "Turns clarified intent and repository evidence into a decision-complete, executable plan without changing source files.",
    triggers: ["plan", "refactor", "implement", "migrate", "build", "strategy"],
    readOnly: true,
    tier: "planning",
    contract: "Produce plans that leave no consequential design decision to the implementer. Name verified paths, ordered dependencies, exact behavior, failure handling, and observable tests.",
  },
  {
    id: "quality-reviewer",
    title: "Quality Reviewer",
    description: "Reviews plans and implementations for blockers, contradictions, unverifiable claims, and missing completion evidence.",
    triggers: ["review", "verify", "plan", "quality", "complete", "evidence"],
    readOnly: true,
    allowBash: true,
    tier: "review",
    contract: "Be approval-biased but evidence-strict: reject verified blockers, not stylistic preferences. Every rejection must identify evidence and a concrete correction.",
  },
  {
    id: "execution-manager",
    title: "Execution Manager",
    description: "Reads an approved plan, sequences work, identifies dependencies, and prepares precise worker handoffs while remaining read-only.",
    triggers: ["execute", "sequence", "coordinate", "plan", "tasks", "handoff"],
    readOnly: true,
    allowBash: true,
    tier: "planning",
    contract: "Coordinate rather than code. Convert the approved plan into ordered work packets, preserve cumulative learnings, and define a verification gate for each packet.",
  },
  {
    id: "implementer",
    title: "Implementer",
    description: "Autonomously explores and implements difficult technical work end-to-end, including deterministic tests and real verification.",
    triggers: ["implement", "fix", "refactor", "deep", "autonomous", "code"],
    readOnly: false,
    tier: "deep",
    contract: "Own the result, not just the patch. Inspect before editing, follow repository conventions, keep scope tight, run real tests, and continue until verified or concretely blocked.",
  },
  {
    id: "task-implementer",
    title: "Task Implementer",
    description: "Executes a bounded implementation task economically when its scope and acceptance criteria are already explicit.",
    triggers: ["quick", "small", "bounded", "single", "focused"],
    readOnly: false,
    tier: "fast",
    contract: "Stay inside the delegated boundary. Make the smallest correct change, add focused regression coverage, and return exact test evidence without widening scope.",
  },
] as const;

const EXTERNAL_RESEARCH_TRIGGERS = [
  "documentation",
  "docs",
  "sdk",
  "library",
  "framework",
  "dependency",
  "version",
  "external api",
  "third-party",
  "integration",
  "standard",
];

export function listWorkflowAgentProfiles(): WorkflowAgentProfile[] {
  return WORKFLOW_AGENTS.map((agent) => ({ ...agent, triggers: [...agent.triggers] }));
}

export function getWorkflowAgentProfile(id: string): WorkflowAgentProfile | undefined {
  const normalized = id.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  const agent = WORKFLOW_AGENTS.find((candidate) => candidate.id === normalized);
  return agent ? { ...agent, triggers: [...agent.triggers] } : undefined;
}

export function resolveWorkflowAgent(
  id: string,
  config: WorkbenchConfig,
  task = "",
  effort: RoutingEffort = "auto",
  routingState: ModelRoutingState = { policy: config.modelRoutingPolicy },
  model?: string,
): WorkflowAgentProfile | undefined {
  const profile = getWorkflowAgentProfile(id);
  if (!profile) return undefined;
  const route = routeTask({ task, role: profile.id, effort, policy: routingState, readOnly: profile.readOnly, model });
  return { ...profile, model: route.model, fastMode: config.fastMode };
}

export function requireAvailableDelegationModel(ctx: Pick<ExtensionContext, "modelRegistry">, model: string | undefined): void {
  if (model === undefined) return;
  const route = parseDelegationModel(model);
  const identity = route.model.replace(/:(low|medium|high)$/, "");
  if (!ctx.modelRegistry?.getAvailable().some((candidate) => `${candidate.provider}/${candidate.id}` === identity)) {
    throw new Error(`Requested model ${identity} is not available in this Pi session. No substitute was selected.`);
  }
}

export function selectPlanningDiscoveryAgentIds(task: string): WorkflowAgentId[] {
  const lower = task.toLowerCase();
  const selected: WorkflowAgentId[] = ["codebase-explorer"];
  if (EXTERNAL_RESEARCH_TRIGGERS.some((trigger) => lower.includes(trigger))) selected.push("researcher");
  return selected;
}

export function validateParallelWorkflowAgents(profiles: WorkflowAgentProfile[]): string | undefined {
  if (profiles.some((profile) => !profile.readOnly)) {
    return "Parallel delegation is read-only only. Run Implementer or Task Implementer alone so write-capable agents cannot race in one working tree.";
  }
  return undefined;
}

export function formatWorkflowRoster(config: WorkbenchConfig): string {
  const rows = WORKFLOW_AGENTS.map((profile) => {
    const access = profile.readOnly ? "read-only" : "writes";
    return `- **${profile.title}** — ${access}; adaptive ${config.modelRoutingPolicy} route chosen from each task lane\n  ${profile.description}`;
  });
  return [
    "- **Coordinator — Main Pi** — coordinates the workflow in the current Pi session.",
    ...rows,
  ].join("\n");
}
