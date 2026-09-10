import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx)$/;
const SENSITIVE_SEGMENTS = new Set(["security", "auth", "payment", "crypto"]);
const RECEIPT_PROMPT_LIMIT = 32 * 1024;
const MAX_DEPENDENTS = 200;
const MAX_CRITICAL_PATHS = 16;
const MAX_DEPTH = 3;
const HEADER = "HOST IMPACT RECEIPT (navigation only; not proof of correctness or completion):";

export type ImpactReceiptStatus = "available" | "unavailable";
export type BlastRadiusLevel = "low" | "medium" | "high" | "critical";
export type ImpactChangeKind = "added" | "deleted" | "modified";

export type ImpactChanges =
  | { status: "available"; changes: Array<{ path: string; kind: ImpactChangeKind }> }
  | { status: "unavailable"; error: string };

export interface ImpactEntity {
  path: string;
  name: string;
  kind: "function" | "class" | "variable" | "type" | "unknown";
  change: "added" | "modified" | "unchanged";
  startLine: number;
  endLine: number;
}

export interface ImpactReceipt {
  version: 1;
  status: ImpactReceiptStatus;
  reason?: string;
  snapshot: string;
  changedPaths: string[];
  entities: ImpactEntity[];
  dependents: Array<{ path: string; depth: number }>;
  blastRadius: { level: BlastRadiusLevel; criticalPaths: string[] };
  untestedChangedFiles: string[];
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function posixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function isSourceFile(name: string): boolean {
  return SOURCE_EXT.test(name) && !name.endsWith(".d.ts");
}

function ignored(name: string): boolean {
  return name === ".git" || name.startsWith(".git/")
    || name === ".pi/pi-workbench" || name.startsWith(".pi/pi-workbench/")
    || name === "node_modules" || name.startsWith("node_modules/")
    || name === ".worktrees" || name.startsWith(".worktrees/");
}

function hasNodeModules(name: string): boolean {
  return name.split("/").includes("node_modules");
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join("/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (/\.test\./.test(base) || /\.spec\./.test(base)) return true;
  return normalized.split("/").some((segment) => segment === "__tests__" || segment === "tests");
}

function hasSensitiveSegment(filePath: string): boolean {
  return filePath.split("/").some((segment) => {
    const lower = segment.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    return SENSITIVE_SEGMENTS.has(lower.replace(/\.(?:ts|tsx|js|jsx)$/, ""));
  });
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function unavailable(snapshot: string, reason: string, changedPaths: string[] = []): ImpactReceipt {
  return {
    version: 1,
    status: "unavailable",
    reason,
    snapshot,
    changedPaths,
    entities: [],
    dependents: [],
    blastRadius: { level: "low", criticalPaths: [] },
    untestedChangedFiles: [],
  };
}

function emptyAvailable(snapshot: string, changedPaths: string[] = []): ImpactReceipt {
  return {
    version: 1,
    status: "available",
    snapshot,
    changedPaths,
    entities: [],
    dependents: [],
    blastRadius: { level: "low", criticalPaths: [] },
    untestedChangedFiles: [],
  };
}

async function listSourceFiles(root: string): Promise<string[]> {
  let names: string[] = [];
  try {
    const result = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    names = [...new Set(result.stdout.split("\0").filter(Boolean))];
  } catch (error) {
    if (!/not a git repository/.test(String((error as { stderr?: string }).stderr))) return [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64 || names.length > 20_000) return;
      let entries;
      try { entries = await fs.readdir(path.join(root, directory), { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const relative = directory ? `${directory}/${entry.name}` : entry.name;
        if (ignored(relative) || hasNodeModules(relative)) continue;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(relative, depth + 1);
        else if (entry.isFile()) names.push(relative.split(path.sep).join("/"));
      }
    };
    await walk("", 0);
  }
  return names.filter((name) => isSourceFile(name) && !ignored(name) && !hasNodeModules(name)).sort();
}

async function readSource(root: string, relative: string): Promise<string | undefined> {
  const file = path.resolve(root, relative);
  if (!within(root, file) || hasNodeModules(posixRelative(root, file))) return undefined;
  try {
    const real = await fs.realpath(file);
    if (!within(root, real)) return undefined;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function parseExportList(inner: string): string[] {
  const names: string[] = [];
  for (const part of inner.split(",")) {
    const bits = part.trim().split(/\s+/).filter((bit) => bit && bit !== "type" && bit !== "typeof");
    const token = bits.length >= 3 && bits[1] === "as" ? bits[2] : bits[0];
    const name = token?.replace(/[^A-Za-z0-9_$]/g, "");
    if (name) names.push(name);
  }
  return names;
}

function extractExports(source: string): Array<{ name: string; kind: ImpactEntity["kind"]; startLine: number; endLine: number }> {
  const found: Array<{ name: string; kind: ImpactEntity["kind"]; startLine: number; endLine: number }> = [];
  const seen = new Set<string>();
  const add = (name: string, kind: ImpactEntity["kind"], index: number) => {
    if (!name) return;
    const startLine = lineAt(source, index);
    const key = `${name}@${startLine}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name, kind, startLine, endLine: startLine });
  };
  for (const match of source.matchAll(/export\s+default\s+(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?/g)) {
    add(match[1] ?? "default", "function", match.index ?? 0);
  }
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1], "function", match.index ?? 0);
  }
  for (const match of source.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1], "class", match.index ?? 0);
  }
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1], "variable", match.index ?? 0);
  }
  for (const match of source.matchAll(/export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    add(match[1], "type", match.index ?? 0);
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const name of parseExportList(match[1])) add(name, "unknown", match.index ?? 0);
  }
  return found;
}

function extractRelativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*(['"])(\.[^'"]*)\1/g)) {
    specifiers.push(match[2]);
  }
  return specifiers;
}

async function resolveSpecifier(root: string, importer: string, specifier: string, allowed: Set<string>): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(path.resolve(root, importer)), specifier);
  const stripped = base.replace(/\.(?:ts|tsx|js|jsx)$/i, "");
  const candidates = [base];
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    candidates.push(stripped + ext);
    candidates.push(path.join(stripped, `index${ext}`));
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (!within(root, candidate)) continue;
    const relative = posixRelative(root, candidate);
    if (hasNodeModules(relative) || ignored(relative)) continue;
    if (allowed.size && !allowed.has(relative)) continue;
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return relative;
    } catch {
      continue;
    }
  }
  return undefined;
}

function blastLevel(dependentCount: number, sensitive: boolean): BlastRadiusLevel {
  if (sensitive || dependentCount >= 9) return "critical";
  if (dependentCount >= 3) return "high";
  if (dependentCount >= 1) return "medium";
  return "low";
}

export async function buildImpactReceipt(input: {
  root: string;
  snapshot: string;
  changes: ImpactChanges;
}): Promise<ImpactReceipt> {
  const { snapshot, changes } = input;
  const root = await fs.realpath(input.root).catch(() => input.root);
  if (changes.status !== "available") return unavailable(snapshot, changes.error || "inventory-unavailable");
  const changedPaths = changes.changes.map((item) => item.path.split(path.sep).join("/"));
  if (changedPaths.length === 0) return emptyAvailable(snapshot);

  const kindByPath = new Map(changes.changes.map((item) => [item.path.split(path.sep).join("/"), item.kind]));
  const listed = await listSourceFiles(root);
  const allowed = new Set([...listed, ...changedPaths.filter(isSourceFile)]);
  const parseableChanged = changes.changes.filter((item) => item.kind !== "deleted" && isSourceFile(item.path));
  let openedChanged = 0;
  const sources = new Map<string, string>();
  for (const relative of allowed) {
    const source = await readSource(root, relative);
    if (source === undefined) continue;
    sources.set(relative, source);
    if (parseableChanged.some((item) => item.path.split(path.sep).join("/") === relative)) openedChanged++;
  }
  if (parseableChanged.length > 0 && openedChanged === 0) {
    return unavailable(snapshot, "no-parseable-sources", changedPaths);
  }

  const entities: ImpactEntity[] = [];
  for (const item of changes.changes) {
    const relative = item.path.split(path.sep).join("/");
    if (item.kind === "deleted" || !isSourceFile(relative)) continue;
    const source = sources.get(relative);
    if (source === undefined) continue;
    const change = item.kind === "added" ? "added" as const : "modified" as const;
    for (const entity of extractExports(source)) {
      entities.push({ path: relative, name: entity.name, kind: entity.kind, change, startLine: entity.startLine, endLine: entity.endLine });
    }
  }
  entities.sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine || a.name.localeCompare(b.name));

  const importers = new Map<string, Set<string>>();
  for (const [importer, source] of sources) {
    for (const specifier of extractRelativeSpecifiers(source)) {
      const target = await resolveSpecifier(root, importer, specifier, allowed);
      if (!target || target === importer) continue;
      const group = importers.get(target) ?? new Set<string>();
      group.add(importer);
      importers.set(target, group);
    }
  }

  const changedSet = new Set(changedPaths);
  const dependents: Array<{ path: string; depth: number }> = [];
  const depthByPath = new Map<string, number>();
  const queue: Array<{ path: string; depth: number }> = [];
  for (const pathName of changedPaths) queue.push({ path: pathName, depth: 0 });
  while (queue.length) {
    const current = queue.shift()!;
    for (const importer of importers.get(current.path) ?? []) {
      if (changedSet.has(importer) || depthByPath.has(importer)) continue;
      const depth = current.depth + 1;
      if (depth > MAX_DEPTH || dependents.length >= MAX_DEPENDENTS) continue;
      depthByPath.set(importer, depth);
      dependents.push({ path: importer, depth });
      queue.push({ path: importer, depth });
    }
  }
  dependents.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  const inboundFromChanged = new Map<string, number>();
  for (const changed of changedSet) {
    for (const importer of importers.get(changed) ?? []) {
      inboundFromChanged.set(importer, (inboundFromChanged.get(importer) ?? 0) + 1);
    }
  }
  const criticalPaths = dependents
    .filter((item) => (inboundFromChanged.get(item.path) ?? 0) >= 3)
    .map((item) => item.path)
    .sort()
    .slice(0, MAX_CRITICAL_PATHS);
  const sensitive = dependents.some((item) => hasSensitiveSegment(item.path));
  const uniqueDependents = new Set(dependents.map((item) => item.path)).size;

  const untestedChangedFiles = changedPaths.filter((filePath) => {
    if (!isSourceFile(filePath) || isTestFile(filePath) || kindByPath.get(filePath) === "deleted") return false;
    const reachable = new Set<string>();
    const queueInner = [filePath];
    const depthInner = new Map<string, number>([[filePath, 0]]);
    while (queueInner.length) {
      const current = queueInner.shift()!;
      const depth = depthInner.get(current) ?? 0;
      for (const importer of importers.get(current) ?? []) {
        if (depthInner.has(importer) || depth + 1 > MAX_DEPTH) continue;
        depthInner.set(importer, depth + 1);
        reachable.add(importer);
        queueInner.push(importer);
      }
    }
    return ![...reachable].some(isTestFile);
  }).sort();

  return {
    version: 1,
    status: "available",
    snapshot,
    changedPaths,
    entities,
    dependents,
    blastRadius: { level: blastLevel(uniqueDependents, sensitive), criticalPaths },
    untestedChangedFiles,
  };
}

export function formatImpactReceiptForReview(receipt: ImpactReceipt): string {
  if (receipt.status === "unavailable") {
    return `${HEADER}\n${JSON.stringify({ status: "unavailable", reason: receipt.reason ?? "unavailable" })}`;
  }
  const render = (value: object) => `${HEADER}\n${JSON.stringify(value)}`;
  let text = render(receipt);
  if (Buffer.byteLength(text, "utf8") <= RECEIPT_PROMPT_LIMIT) return text;
  text = `${render({ ...receipt, dependents: receipt.dependents.slice(0, 50), truncated: true })}\ntruncated: dependents omitted beyond 50`;
  return text;
}

export async function readCachedImpactReceipt(
  dir: string,
  snapshot: string,
  changedPaths?: string[],
): Promise<ImpactReceipt | undefined> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.startsWith("impact-") && name.endsWith(".md"));
  } catch {
    return undefined;
  }
  const expected = changedPaths?.slice().sort().join("\0");
  const matches: Array<{ receipt: ImpactReceipt; mtime: number; snapshotMatch: boolean }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!within(dir, file)) continue;
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as ImpactReceipt;
      if (parsed?.version !== 1 || (parsed.status !== "available" && parsed.status !== "unavailable")) continue;
      if (!Array.isArray(parsed.changedPaths)) continue;
      if (expected && [...parsed.changedPaths].sort().join("\0") !== expected) continue;
      matches.push({ receipt: parsed, mtime: stat.mtimeMs, snapshotMatch: parsed.snapshot === snapshot });
    } catch {
      continue;
    }
  }
  const snapshotHits = matches.filter((item) => item.snapshotMatch);
  const pool = snapshotHits.length > 0 ? snapshotHits : expected ? [] : matches;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]?.receipt;
}

export async function loadLatestImpactReceipt(dir: string, snapshot: string): Promise<ImpactReceipt | undefined> {
  return readCachedImpactReceipt(dir, snapshot);
}
