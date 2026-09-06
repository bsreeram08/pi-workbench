import type { WorkflowAgentId } from "./workflow-agents.ts";

export interface ConceptRouting {
  skills: string[];
  principles: string[];
  packs: Array<"engineering" | "design" | "experimentation">;
}

const UI_TERMS = [
  "ui", "ux", "interface", "screen", "component", "button", "popover", "modal", "drawer",
  "animation", "motion", "transition", "gesture", "design", "css", "react", "compose", "swiftui",
  "accessibility", "responsive", "mobile", "desktop",
];

const EXPERIMENT_TERMS = [
  "optimize", "optimization", "benchmark", "metric", "performance", "latency", "throughput",
  "bundle size", "experiment", "autoresearch", "search space", "training", "accuracy", "score",
];

const BUG_TERMS = ["bug", "broken", "crash", "failure", "regression", "debug", "slow", "root cause"];
const ARCHITECTURE_TERMS = ["architecture", "refactor", "module", "interface", "boundary", "seam", "dependency", "migration"];

function includesAny(task: string, terms: readonly string[]): boolean {
  const lower = task.toLowerCase();
  return terms.some((term) => new RegExp(`(?:^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`, "i").test(lower));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function routeConcepts(task: string, agentId: WorkflowAgentId): ConceptRouting {
  const skills: string[] = [];
  const principles: string[] = [];
  const packs: ConceptRouting["packs"] = ["engineering"];

  // Matt Pocock's engineering discipline is the baseline: alignment, shared language,
  // small feedback loops, deep modules, and tests at observable seams.
  if (["requirements-analyst", "planner", "execution-manager"].includes(agentId)) {
    skills.push("domain-modeling", "codebase-design");
    if (includesAny(task, ["grilling", "grill me", "interview me"])) skills.push("grilling");
    principles.push(
      "Resolve consequential ambiguity before code; do not make the user choose trivia repository evidence can settle.",
      "Use the project's ubiquitous language and preserve durable decisions so future agents do not rediscover them.",
      "Break large work into small, ordered tracer bullets whose feedback loops fit inside one worker context.",
    );
  }
  if (["implementer", "task-implementer"].includes(agentId)) {
    skills.push("tdd", "codebase-design");
    principles.push(
      "Move in small vertical slices; the rate of trustworthy feedback is the speed limit.",
      "Use red-green-refactor at the behavior seam when deterministic tests are feasible.",
      "Prefer deep modules: a small interface hiding substantial behavior at a clean, testable seam.",
    );
  }
  if (agentId === "quality-reviewer") {
    skills.push("code-review");
    principles.push(
      "Review on two independent axes: repository standards and conformance to the user's approved intent.",
      "Do not let style commentary obscure a missing behavior, regression, or unverifiable completion claim.",
    );
  }
  if (agentId === "technical-reviewer" || includesAny(task, ARCHITECTURE_TERMS)) {
    skills.push("codebase-design");
    principles.push("Apply the deletion test: a useful module removes complexity from callers rather than merely moving names around.");
  }
  if (agentId === "technical-reviewer" || includesAny(task, BUG_TERMS)) {
    skills.push("diagnosing-bugs");
    principles.push("For defects, establish a reproducing feedback loop, minimize, hypothesize, instrument, then fix and regression-test.");
  }

  // Emil Kowalski's design-engineering concepts apply only to user-facing work.
  if (includesAny(task, UI_TERMS)) {
    packs.push("design");
    skills.push(
      agentId === "quality-reviewer" ? "review-animations" : "emil-design-eng",
      ...(agentId === "implementer" || agentId === "task-implementer" ? ["animate"] : []),
    );
    principles.push(
      "Treat taste as trained judgment: invisible details, good defaults, and handled edge cases compound into perceived quality.",
      "Before adding motion, decide whether it should animate, why, how frequently it appears, how it interrupts, and how reduced motion behaves.",
      "Keep frequent and keyboard-driven interactions immediate; prefer responsive, interruptible motion and verify on real input modes and devices.",
      "Do not hand-roll a UI primitive when a trusted, maintained library already handles its invisible edge cases.",
    );
  }

  // Karpathy/autoresearch concepts apply to measurable optimization and search problems.
  if (includesAny(task, EXPERIMENT_TERMS)) {
    packs.push("experimentation");
    skills.push("autoresearch-create");
    principles.push(
      "Freeze the objective, evaluation harness, scope, constraints, and time budget before experimenting; establish a baseline first.",
      "Run hypothesis-led iterations, measure the primary metric, keep real gains, revert regressions, and log failures and learnings durably.",
      "Protect metric integrity with correctness checks and secondary metrics; random seeds and evaluator changes are not product improvements.",
      "Prefer a simpler equal result over extra complexity, account for measurement noise, and change search strategy when iterations begin to thrash.",
      "Treat community issue proposals as hypothesis seeds, not established facts; verify them against the local workload.",
    );
  }

  if (agentId === "codebase-explorer") skills.push("codebase-design");
  if (agentId === "researcher") skills.push("research");

  return { skills: unique(skills), principles: unique(principles), packs: unique(packs) as ConceptRouting["packs"] };
}

export function formatConceptGuidance(task: string, agentId: WorkflowAgentId, communityKnowledgePath?: string): string {
  const routed = routeConcepts(task, agentId);
  const skillLine = routed.skills.length > 0
    ? `Relevant skill candidates: ${routed.skills.map((skill) => `\`${skill}\``).join(", ")}. Use the selected skill content supplied in your delegated context when it fits this task. Missing skills are not a reason to search outside your delegated access.`
    : "Use the repository instructions and any relevant skill content supplied in your delegated context.";
  const principles = routed.principles.map((principle) => `- ${principle}`).join("\n");
  const community = routed.packs.includes("experimentation") && communityKnowledgePath
    ? `\nAutoresearch community hypothesis feed: ${communityKnowledgePath}. Consult it for experiment ideas when useful, but do not treat issue claims as validated evidence.`
    : "";
  return `## Routed capability guidance\n${skillLine}\n\nConcept packs: ${routed.packs.join(", ")}\n${principles}${community}`;
}
