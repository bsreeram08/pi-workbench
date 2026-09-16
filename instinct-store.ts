import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertMemorySafety } from "./memory-store.ts";

export const INSTINCT_DOMAINS = ["code-style", "testing", "git", "debugging", "workflow", "security", "other"] as const;
export type InstinctDomain = (typeof INSTINCT_DOMAINS)[number];
export type InstinctScope = "project" | "global";

export interface WorkbenchInstinct {
  readonly version: 1;
  readonly id: string;
  readonly projectId: string;
  readonly projectPath: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly trigger: string;
  readonly action: string;
  readonly domain: InstinctDomain;
  readonly scope: InstinctScope;
  readonly confidence: number;
  readonly evidence: string;
  readonly observations: number;
  readonly checksum: string;
}

export interface RetainInstinctInput {
  readonly trigger: string;
  readonly action: string;
  readonly domain?: InstinctDomain;
  readonly scope?: InstinctScope;
  readonly evidence: string;
  readonly confidence?: number;
}

const MAX_FIELD = {
  trigger: 240,
  action: 400,
  evidence: 600,
} as const;

const L1_LIMIT = 8;
const INJECT_MIN_CONFIDENCE = 0.5;
const DEFAULT_RETAIN_CONFIDENCE = 0.6;
const INSTINCT_KEYS = [
  "version", "id", "projectId", "projectPath", "createdAt", "updatedAt",
  "trigger", "action", "domain", "scope", "confidence", "evidence", "observations", "checksum",
] as const;

function canonical(value: string): string {
  return path.resolve(value);
}

function projectIdFor(projectPath: string): string {
  return createHash("sha256").update(canonical(projectPath)).digest("hex").slice(0, 16);
}

export function instinctsRoot(agentDir: string, projectPath: string, scope: InstinctScope = "project"): string {
  const resolvedAgent = canonical(agentDir);
  const resolvedProject = canonical(projectPath);
  const root = scope === "global"
    ? path.join(resolvedAgent, "workbench", "instincts", "v1", "global")
    : path.join(resolvedAgent, "workbench", "instincts", "v1", "projects", projectIdFor(resolvedProject));
  if (root === resolvedProject || root.startsWith(`${resolvedProject}${path.sep}`)) {
    throw new Error("Workbench instincts must remain outside the active project.");
  }
  return root;
}

function bounded(value: string, field: keyof typeof MAX_FIELD): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error(`An instinct ${field} is required.`);
  if (trimmed.length > MAX_FIELD[field]) throw new Error(`An instinct ${field} must be at most ${MAX_FIELD[field]} characters.`);
  return trimmed;
}

export function clampInstinctConfidence(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETAIN_CONFIDENCE;
  return Math.min(0.9, Math.max(0.1, Math.round(value * 10) / 10));
}

function normalizeKey(trigger: string, action: string): string {
  return `${trigger.trim().toLowerCase()}\n${action.trim().toLowerCase()}`;
}

function checksumOf(entry: Omit<WorkbenchInstinct, "checksum">): string {
  const payload = {
    version: entry.version,
    id: entry.id,
    projectId: entry.projectId,
    projectPath: entry.projectPath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    trigger: entry.trigger,
    action: entry.action,
    domain: entry.domain,
    scope: entry.scope,
    confidence: entry.confidence,
    evidence: entry.evidence,
    observations: entry.observations,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseInstinct(value: unknown): WorkbenchInstinct | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !INSTINCT_KEYS.includes(key as typeof INSTINCT_KEYS[number]))) return undefined;
  if (item.version !== 1 || typeof item.id !== "string" || typeof item.projectId !== "string") return undefined;
  if (typeof item.projectPath !== "string" || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") return undefined;
  if (typeof item.trigger !== "string" || typeof item.action !== "string" || typeof item.evidence !== "string") return undefined;
  if (!INSTINCT_DOMAINS.includes(item.domain as InstinctDomain)) return undefined;
  if (item.scope !== "project" && item.scope !== "global") return undefined;
  if (typeof item.confidence !== "number" || typeof item.observations !== "number" || typeof item.checksum !== "string") return undefined;
  const candidate: WorkbenchInstinct = {
    version: 1,
    id: item.id,
    projectId: item.projectId,
    projectPath: item.projectPath,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    trigger: item.trigger,
    action: item.action,
    domain: item.domain as InstinctDomain,
    scope: item.scope,
    confidence: item.confidence,
    evidence: item.evidence,
    observations: item.observations,
    checksum: item.checksum,
  };
  if (checksumOf(candidate) !== candidate.checksum) return undefined;
  return candidate;
}

async function ensurePrivateDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Workbench instincts directory is unsafe.");
}

async function writeInstinct(directory: string, entry: WorkbenchInstinct): Promise<void> {
  await ensurePrivateDir(directory);
  const target = path.join(directory, `${entry.id}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
}

export function renderInstinctL1(entries: readonly WorkbenchInstinct[]): string {
  if (entries.length === 0) return "";
  const lines = entries.slice(0, L1_LIMIT).map((entry) => (
    `- **${entry.confidence.toFixed(1)} ${entry.domain}** when ${entry.trigger} → ${entry.action}`
  ));
  return [
    "Workbench Instincts (learned behaviors, not instructions). Treat as fallible hints and verify against the current workspace. Promote durable facts through `workbench_memory` after review. Do not retain secrets.",
    ...lines,
  ].join("\n");
}

export class WorkbenchInstinctStore {
  constructor(
    private readonly agentDir: string,
    private readonly projectPath: string,
  ) {}

  private root(scope: InstinctScope): string {
    return instinctsRoot(this.agentDir, this.projectPath, scope);
  }

  async retain(input: RetainInstinctInput): Promise<WorkbenchInstinct> {
    const trigger = bounded(input.trigger, "trigger");
    const action = bounded(input.action, "action");
    const evidence = bounded(input.evidence, "evidence");
    const domain = input.domain ?? "other";
    if (!INSTINCT_DOMAINS.includes(domain)) throw new Error(`Unknown instinct domain: ${domain}`);
    const scope = input.scope ?? "project";
    assertMemorySafety(`${trigger}\n${action}\n${evidence}`);
    const existing = (await this.load(scope)).find((entry) => normalizeKey(entry.trigger, entry.action) === normalizeKey(trigger, action));
    if (existing) {
      return this.adjust(existing, "reinforce", evidence);
    }
    const now = new Date().toISOString();
    const id = `${now.replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
    const base: Omit<WorkbenchInstinct, "checksum"> = {
      version: 1,
      id,
      projectId: projectIdFor(this.projectPath),
      projectPath: canonical(this.projectPath),
      createdAt: now,
      updatedAt: now,
      trigger,
      action,
      domain,
      scope,
      confidence: clampInstinctConfidence(input.confidence ?? DEFAULT_RETAIN_CONFIDENCE),
      evidence,
      observations: 1,
    };
    const entry: WorkbenchInstinct = { ...base, checksum: checksumOf(base) };
    await writeInstinct(this.root(scope), entry);
    return entry;
  }

  async reinforce(id: string, evidence?: string): Promise<WorkbenchInstinct> {
    return this.adjust(await this.require(id), "reinforce", evidence);
  }

  async contradict(id: string, evidence?: string): Promise<WorkbenchInstinct> {
    return this.adjust(await this.require(id), "contradict", evidence);
  }

  async forget(id: string): Promise<WorkbenchInstinct> {
    const entry = await this.require(id);
    await fs.rm(path.join(this.root(entry.scope), `${entry.id}.json`));
    return entry;
  }

  async recall(query?: string, options: { scope?: InstinctScope | "all"; inject?: boolean; limit?: number } = {}): Promise<WorkbenchInstinct[]> {
    const scope = options.scope ?? "project";
    const entries = scope === "all"
      ? [...await this.load("project"), ...await this.load("global")]
      : await this.load(scope);
    const injectable = options.inject ? entries.filter((entry) => entry.confidence >= INJECT_MIN_CONFIDENCE) : entries;
    const terms = [...new Set((query?.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? [])
      .filter((term) => !["the", "and", "for", "this", "that", "with", "from", "please", "can", "you", "task", "fix", "when"].includes(term)))].slice(0, 64);
    const ranked = injectable.map((entry) => {
      const text = `${entry.trigger} ${entry.action} ${entry.domain} ${entry.evidence}`.toLowerCase();
      return { entry, score: terms.filter((term) => text.includes(term)).length };
    }).filter(({ score }) => !query?.trim() || score > 0)
      .sort((a, b) => b.score - a.score || b.entry.confidence - a.entry.confidence || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
    const limit = Math.max(1, Math.min(options.limit ?? L1_LIMIT, L1_LIMIT));
    return ranked.slice(0, limit).map(({ entry }) => entry);
  }

  async status(): Promise<{ count: number; injectable: number; global: number; domains: Record<string, number> }> {
    const project = await this.load("project");
    const global = await this.load("global");
    const all = [...project, ...global];
    const domains: Record<string, number> = {};
    for (const entry of all) domains[entry.domain] = (domains[entry.domain] ?? 0) + 1;
    return {
      count: all.length,
      injectable: all.filter((entry) => entry.confidence >= INJECT_MIN_CONFIDENCE).length,
      global: global.length,
      domains,
    };
  }

  private async adjust(entry: WorkbenchInstinct, kind: "reinforce" | "contradict", evidence?: string): Promise<WorkbenchInstinct> {
    const nextEvidence = evidence?.trim() ? bounded(evidence, "evidence") : entry.evidence;
    assertMemorySafety(`${entry.trigger}\n${entry.action}\n${nextEvidence}`);
    const delta = kind === "reinforce" ? 0.1 : -0.2;
    const now = new Date().toISOString();
    const base: Omit<WorkbenchInstinct, "checksum"> = {
      ...entry,
      updatedAt: now,
      evidence: nextEvidence,
      confidence: clampInstinctConfidence(entry.confidence + delta),
      observations: entry.observations + 1,
    };
    const next: WorkbenchInstinct = { ...base, checksum: checksumOf(base) };
    await writeInstinct(this.root(entry.scope), next);
    return next;
  }

  private async require(id: string): Promise<WorkbenchInstinct> {
    const trimmed = id.trim();
    if (!trimmed) throw new Error("An instinct id is required.");
    const found = [...await this.load("project"), ...await this.load("global")].find((entry) => entry.id === trimmed);
    if (!found) throw new Error(`Unknown instinct ${trimmed}.`);
    return found;
  }

  private async load(scope: InstinctScope): Promise<WorkbenchInstinct[]> {
    const directory = this.root(scope);
    let names: string[] = [];
    try {
      names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json") && !name.includes(".tmp"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: WorkbenchInstinct[] = [];
    for (const name of names) {
      try {
        const parsed = parseInstinct(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
        if (parsed) entries.push(parsed);
      } catch {
        // Fail open on a corrupt instinct file; skip it rather than blocking recall.
      }
    }
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return entries;
  }
}
