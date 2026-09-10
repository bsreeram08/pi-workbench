import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectPaths } from "./types.ts";
import { normalizeRoutingFamily, normalizeRoutingPolicy, type RoutingFamily, type RoutingPolicy } from "./routing.ts";

export interface WorkbenchConfig {
  workflowMode: "focused" | "thorough";
  maxCouncilAgents: number;
  parallelImplementationWorkers: number;
  maxFixLoops: number;
  defaultImplementationSession: "ask" | "same" | "new";
  qmdEnabled: boolean;
  fastMode: boolean;
  maxResearchAgents: number;
  researchSourcesPerTrack: number;
  researchOutputDir: string;
  researchDefaultDepth: "fast" | "decision-grade";
  researchRequirePlanConfirmation: boolean;
  researchWorkerModel: string | null;
  researchSynthesisModel: string | null;
  researchAuditModel: string | null;
  workflowMaxParallelAgents: number;
  workflowMaxInterviewRounds: number;
  workflowMaxPlanReviewLoops: number;
  workflowMaxFixLoops: number;
  workflowFastModel: string | null;
  workflowPlanningModel: string | null;
  workflowDeepModel: string | null;
  workflowReviewModel: string | null;
  modelRoutingPolicy: Exclude<RoutingPolicy, "fixed">;
  modelRoutingFamily: RoutingFamily;
}

export const DEFAULT_CONFIG: WorkbenchConfig = {
  workflowMode: "focused",
  maxCouncilAgents: 6,
  parallelImplementationWorkers: 1,
  maxFixLoops: 5,
  defaultImplementationSession: "ask",
  qmdEnabled: true,
  fastMode: true,
  maxResearchAgents: 5,
  researchSourcesPerTrack: 6,
  researchOutputDir: "research",
  researchDefaultDepth: "decision-grade",
  researchRequirePlanConfirmation: true,
  researchWorkerModel: "openai-codex/gpt-5.4-mini:medium",
  researchSynthesisModel: "openai-codex/gpt-5.6-sol:high",
  researchAuditModel: "openai-codex/gpt-5.4:high",
  workflowMaxParallelAgents: 4,
  workflowMaxInterviewRounds: 2,
  workflowMaxPlanReviewLoops: 3,
  workflowMaxFixLoops: 3,
  workflowFastModel: "openai-codex/gpt-5.4-mini:medium",
  workflowPlanningModel: "openai-codex/gpt-5.6-sol:high",
  workflowDeepModel: "openai-codex/gpt-5.6-sol:medium",
  workflowReviewModel: "openai-codex/gpt-5.6-terra:high",
  modelRoutingPolicy: "balanced",
  modelRoutingFamily: "grok",
};

export function configPath(paths: ProjectPaths): string {
  return path.join(paths.stateDir, "config.json");
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function optionalModel(input: Record<string, unknown>, key: string, fallback: string | null): string | null {
  if (!(key in input)) return fallback;
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeRelativeDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_CONFIG.researchOutputDir;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return DEFAULT_CONFIG.researchOutputDir;
  if (normalized.split("/").some((part) => part === ".." || part === "")) return DEFAULT_CONFIG.researchOutputDir;
  return normalized;
}

export function normalizeConfig(value: unknown): WorkbenchConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const session = input.defaultImplementationSession;
  return {
    workflowMode: input.workflowMode === "thorough" ? "thorough" : "focused",
    maxCouncilAgents: boundedInteger(input.maxCouncilAgents, DEFAULT_CONFIG.maxCouncilAgents, 3, 8),
    parallelImplementationWorkers: boundedInteger(
      input.parallelImplementationWorkers,
      DEFAULT_CONFIG.parallelImplementationWorkers,
      1,
      4,
    ),
    maxFixLoops: boundedInteger(input.maxFixLoops, DEFAULT_CONFIG.maxFixLoops, 1, 10),
    defaultImplementationSession:
      session === "same" || session === "new" || session === "ask" ? session : DEFAULT_CONFIG.defaultImplementationSession,
    qmdEnabled: typeof input.qmdEnabled === "boolean" ? input.qmdEnabled : DEFAULT_CONFIG.qmdEnabled,
    fastMode: typeof input.fastMode === "boolean" ? input.fastMode : DEFAULT_CONFIG.fastMode,
    maxResearchAgents: boundedInteger(input.maxResearchAgents, DEFAULT_CONFIG.maxResearchAgents, 3, 6),
    researchSourcesPerTrack: boundedInteger(input.researchSourcesPerTrack, DEFAULT_CONFIG.researchSourcesPerTrack, 3, 12),
    researchOutputDir: safeRelativeDirectory(input.researchOutputDir),
    researchDefaultDepth:
      input.researchDefaultDepth === "fast" || input.researchDefaultDepth === "decision-grade"
        ? input.researchDefaultDepth
        : DEFAULT_CONFIG.researchDefaultDepth,
    researchRequirePlanConfirmation:
      typeof input.researchRequirePlanConfirmation === "boolean"
        ? input.researchRequirePlanConfirmation
        : DEFAULT_CONFIG.researchRequirePlanConfirmation,
    researchWorkerModel: optionalModel(input, "researchWorkerModel", DEFAULT_CONFIG.researchWorkerModel),
    researchSynthesisModel: optionalModel(input, "researchSynthesisModel", DEFAULT_CONFIG.researchSynthesisModel),
    researchAuditModel: optionalModel(input, "researchAuditModel", DEFAULT_CONFIG.researchAuditModel),
    workflowMaxParallelAgents: boundedInteger(
      input.workflowMaxParallelAgents,
      DEFAULT_CONFIG.workflowMaxParallelAgents,
      1,
      6,
    ),
    workflowMaxInterviewRounds: boundedInteger(
      input.workflowMaxInterviewRounds,
      DEFAULT_CONFIG.workflowMaxInterviewRounds,
      0,
      4,
    ),
    workflowMaxPlanReviewLoops: boundedInteger(
      input.workflowMaxPlanReviewLoops,
      DEFAULT_CONFIG.workflowMaxPlanReviewLoops,
      1,
      5,
    ),
    workflowMaxFixLoops: boundedInteger(
      input.workflowMaxFixLoops,
      DEFAULT_CONFIG.workflowMaxFixLoops,
      0,
      8,
    ),
    workflowFastModel: optionalModel(input, "workflowFastModel", DEFAULT_CONFIG.workflowFastModel),
    workflowPlanningModel: optionalModel(input, "workflowPlanningModel", DEFAULT_CONFIG.workflowPlanningModel),
    workflowDeepModel: optionalModel(input, "workflowDeepModel", DEFAULT_CONFIG.workflowDeepModel),
    workflowReviewModel: optionalModel(input, "workflowReviewModel", DEFAULT_CONFIG.workflowReviewModel),
    modelRoutingPolicy: normalizeRoutingPolicy(input.modelRoutingPolicy),
    modelRoutingFamily: normalizeRoutingFamily(input.modelRoutingFamily),
  };
}

export async function loadConfig(paths: ProjectPaths): Promise<WorkbenchConfig> {
  try {
    return normalizeConfig(JSON.parse(await fs.readFile(configPath(paths), "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(paths: ProjectPaths, config: WorkbenchConfig): Promise<void> {
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(configPath(paths), JSON.stringify(normalizeConfig(config), null, 2) + "\n", "utf8");
}
