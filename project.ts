import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Exec, ProjectPaths, QmdResult, CouncilSession } from "./types.ts";

const STATE_DIR_NAME = "pi-workbench";

export interface CouncilAuthoritySnapshot {
  readonly sessionContent?: string;
  readonly intentContent?: string;
  readonly session?: CouncilSession;
  readonly intent: string;
}

export class CouncilAuthoritySnapshotMismatchError extends Error {
  constructor() {
    super("Authoritative council state changed after confirmation; rerun the command and reconfirm.");
    this.name = "CouncilAuthoritySnapshotMismatchError";
  }
}

function projectId(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 10);
}

function gitStdout(root: string, args: string[]): string {
  try {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    // Non-git directories keep the checkout path as identity.
  }
  return "";
}

/** Primary checkout for this Git repo. Linked worktrees share the main toplevel. */
export function canonicalProjectRoot(root: string): string {
  const resolved = path.resolve(root);
  const common = gitStdout(resolved, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    || gitStdout(resolved, ["rev-parse", "--git-common-dir"]);
  if (!common) {
    try { return fsSync.realpathSync(resolved); } catch { return resolved; }
  }
  const gitDir = path.resolve(resolved, common);
  const primary = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
  const toplevel = gitStdout(primary, ["rev-parse", "--show-toplevel"]) || primary;
  try { return fsSync.realpathSync(toplevel); } catch { return path.resolve(toplevel); }
}

export function qmdCollectionNames(root: string): { stateCollection: string; projectCollection: string } {
  const id = projectId(canonicalProjectRoot(root));
  return {
    stateCollection: `pi-workbench-state-${id}`,
    projectCollection: `pi-workbench-project-${id}`,
  };
}

export function findProjectRootSync(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolved,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    // A non-git directory is still a valid project for council planning.
  }
  return resolved;
}

export async function resolveGitCheckoutRoot(candidate: string | undefined, sessionRoot: string): Promise<string> {
  const session = path.resolve(sessionRoot);
  if (!candidate?.trim()) return session;
  const resolved = path.resolve(session, candidate.trim());
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw new Error(`Implementation root does not exist: ${resolved}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Implementation root must be a real Git checkout directory, not a symlink or file.");
  const real = await fs.realpath(resolved);
  const git = spawnSync("git", ["-C", real, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10_000 });
  const toplevel = git.status === 0 ? git.stdout.trim() : "";
  if (!toplevel || path.resolve(toplevel) !== real) {
    throw new Error("Implementation root must be the toplevel of a Git checkout. Pass that repo's path as root; do not start a second Pi.");
  }
  return real;
}

export async function findProjectRoot(cwd: string, exec: Exec): Promise<string> {
  try {
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { timeout: 10_000 });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  } catch {
    // A non-git directory is still a valid project for council planning.
  }
  return cwd;
}

export function getProjectPaths(root: string): ProjectPaths {
  const stateDir = path.join(root, ".pi", STATE_DIR_NAME);
  return {
    root,
    stateDir,
    intent: path.join(stateDir, "Intent.md"),
    decisions: path.join(stateDir, "decisions.md"),
    implementationPlan: path.join(stateDir, "ImplementationPlan.md"),
    session: path.join(stateDir, "session.json"),
    qmd: path.join(stateDir, "qmd.json"),
  };
}

async function ensureContainedDirectory(root: string, canonicalRoot: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Project state path escapes the project root.");
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = await fs.lstat(current).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 });
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe project state directory: ${current}`);
    const expectedReal = path.join(canonicalRoot, path.relative(root, current));
    if (await fs.realpath(current) !== expectedReal) throw new Error(`Unsafe project state directory: ${current}`);
  }
}

async function ensureDecisionFile(pathname: string): Promise<void> {
  const existing = await fs.lstat(pathname).catch((error) => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Unsafe project decision file: ${pathname}`);
    return;
  }
  const temporary = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile("# Sreeram's Pi Workbench Decisions\n\nDecisions are appended here. Each entry records what the user chose and why.\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = await fs.lstat(pathname);
      if (raced.isSymbolicLink() || !raced.isFile()) throw new Error(`Unsafe project decision file: ${pathname}`);
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function ensureProjectState(paths: ProjectPaths): Promise<void> {
  const root = path.resolve(paths.root);
  const expectedStateDir = path.join(root, ".pi", STATE_DIR_NAME);
  if (path.resolve(paths.stateDir) !== expectedStateDir || path.resolve(paths.decisions) !== path.join(expectedStateDir, "decisions.md")) {
    throw new Error("Invalid project state paths.");
  }
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Unsafe project root.");
  const canonicalRoot = await fs.realpath(root);
  await ensureContainedDirectory(root, canonicalRoot, path.join(root, ".pi"));
  await ensureContainedDirectory(root, canonicalRoot, expectedStateDir);
  await ensureDecisionFile(paths.decisions);
}

export async function readOptional(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content.trimEnd() + "\n", "utf8");
}

async function readAuthorityFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function captureCouncilAuthority(paths: ProjectPaths): Promise<CouncilAuthoritySnapshot> {
  const [sessionContent, intentContent] = await Promise.all([
    readAuthorityFile(paths.session),
    readAuthorityFile(paths.intent),
  ]);
  let session: CouncilSession | undefined;
  if (sessionContent !== undefined) {
    try {
      session = JSON.parse(sessionContent) as CouncilSession;
    } catch {
      session = undefined;
    }
  }
  return { sessionContent, intentContent, session, intent: intentContent ?? "" };
}

export async function assertCouncilAuthorityUnchanged(
  paths: ProjectPaths,
  expected: CouncilAuthoritySnapshot,
): Promise<CouncilAuthoritySnapshot> {
  const current = await captureCouncilAuthority(paths);
  if (current.sessionContent !== expected.sessionContent || current.intentContent !== expected.intentContent) {
    throw new CouncilAuthoritySnapshotMismatchError();
  }
  return current;
}

export async function loadSession(paths: ProjectPaths): Promise<CouncilSession | undefined> {
  try {
    const content = await fs.readFile(paths.session, "utf8");
    return JSON.parse(content) as CouncilSession;
  } catch {
    return undefined;
  }
}

export async function saveSession(paths: ProjectPaths, session: CouncilSession): Promise<void> {
  await writeText(paths.session, JSON.stringify(session, null, 2));
}

export async function archiveCurrentState(paths: ProjectPaths): Promise<void> {
  const session = await loadSession(paths);
  if (!session) return;
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const archiveDir = path.join(paths.stateDir, "archive", stamp);
  await fs.mkdir(archiveDir, { recursive: true });
  for (const source of [paths.intent, paths.implementationPlan, paths.session]) {
    try {
      await fs.copyFile(source, path.join(archiveDir, path.basename(source)));
    } catch {
      // Missing documents are valid for incomplete council runs.
    }
  }
}

export async function appendDecision(paths: ProjectPaths, entry: string): Promise<void> {
  const existing = await readOptional(paths.decisions);
  const separator = existing.endsWith("\n") ? "" : "\n";
  await writeText(paths.decisions, `${existing}${separator}\n${entry}`);
}

interface QmdConfig {
  stateCollection: string;
  projectCollection: string;
  extraCollections?: string[];
}

export async function readQmdConfig(paths: ProjectPaths): Promise<QmdConfig | undefined> {
  try {
    return JSON.parse(await fs.readFile(paths.qmd, "utf8")) as QmdConfig;
  } catch {
    return undefined;
  }
}

export async function ensureQmdCollections(paths: ProjectPaths, exec: Exec): Promise<QmdConfig | undefined> {
  const knowledgeRoot = canonicalProjectRoot(paths.root);
  const names = qmdCollectionNames(knowledgeRoot);
  const knowledgePaths = getProjectPaths(knowledgeRoot);
  const existing = await readQmdConfig(paths);
  const extra = new Set(existing?.extraCollections ?? []);
  if (existing && (existing.stateCollection !== names.stateCollection || existing.projectCollection !== names.projectCollection)) {
    extra.add(existing.stateCollection);
    extra.add(existing.projectCollection);
  }
  const config: QmdConfig = {
    ...names,
    ...(extra.size > 0 ? { extraCollections: [...extra].sort() } : {}),
  };
  if (
    existing
    && existing.stateCollection === config.stateCollection
    && existing.projectCollection === config.projectCollection
    && JSON.stringify(existing.extraCollections ?? []) === JSON.stringify(config.extraCollections ?? [])
  ) {
    return existing;
  }

  try {
    const state = await exec("qmd", ["collection", "add", knowledgePaths.stateDir, "--name", config.stateCollection], {
      timeout: 30_000,
    });
    if (state.code !== 0 && !/already exists|already registered/i.test(`${state.stdout}\n${state.stderr}`)) {
      return existing;
    }

    const project = await exec("qmd", ["collection", "add", knowledgeRoot, "--name", config.projectCollection], {
      timeout: 60_000,
    });
    if (project.code !== 0 && !/already exists|already registered/i.test(`${project.stdout}\n${project.stderr}`)) {
      return existing;
    }

    await writeText(paths.qmd, JSON.stringify(config, null, 2));
    if (knowledgeRoot !== path.resolve(paths.root)) {
      await writeText(knowledgePaths.qmd, JSON.stringify({
        stateCollection: config.stateCollection,
        projectCollection: config.projectCollection,
      }, null, 2)).catch(() => undefined);
    }
    return config;
  } catch {
    return existing;
  }
}

export async function refreshQmd(exec: Exec): Promise<void> {
  try {
    await exec("qmd", ["update"], { timeout: 120_000 });
  } catch {
    // Knowledge retrieval is an enhancement; a missing/broken index must not lose the council run.
  }
}

export function allowedQmdCollections(config: {
  stateCollection: string;
  projectCollection: string;
  extraCollections?: string[];
} | undefined): string[] {
  if (!config) return [];
  return [...new Set([config.stateCollection, config.projectCollection, ...(config.extraCollections ?? [])])];
}

export function resolveQmdCollections(
  requested: string | undefined,
  allowed: string[],
): { ok: true; collections: string[] } | { ok: false; reason: string } {
  if (allowed.length === 0) return { ok: false, reason: "Project QMD collections are not configured." };
  if (!requested?.trim()) return { ok: true, collections: allowed };
  if (!allowed.includes(requested)) return { ok: false, reason: "Unknown QMD collection." };
  return { ok: true, collections: [requested] };
}

export async function searchQmd(
  paths: ProjectPaths,
  exec: Exec,
  query: string,
  limit = 8,
): Promise<QmdResult[]> {
  const config = await readQmdConfig(paths);
  if (!config) return [];

  const results: QmdResult[] = [];
  for (const collection of [config.stateCollection, config.projectCollection]) {
    try {
      const result = await exec(
        "qmd",
        ["search", "--json", "-c", collection, "-n", String(limit), query],
        { timeout: 30_000 },
      );
      if (result.code !== 0) continue;
      const parsed = JSON.parse(result.stdout) as unknown;
      if (Array.isArray(parsed)) results.push(...(parsed as QmdResult[]));
    } catch {
      // Continue with the other collection and let the caller work without QMD if needed.
    }
  }

  const unique = new Map<string, QmdResult>();
  for (const result of results) {
    const key = result.file ?? result.docid ?? JSON.stringify(result);
    if (!unique.has(key)) unique.set(key, result);
  }
  return [...unique.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
}

export function formatQmdResults(results: QmdResult[]): string {
  if (results.length === 0) return "No QMD results were available.";
  return results
    .map((result, index) => {
      const location = result.file ?? result.docid ?? "unknown document";
      const score = result.score === undefined ? "" : ` (score ${result.score.toFixed(2)})`;
      return `### ${index + 1}. ${location}${score}\n${result.snippet ?? result.title ?? "(no snippet)"}`;
    })
    .join("\n\n");
}

export function formatSessionSummary(session: CouncilSession | undefined): string {
  if (!session) return "This project has no Sreeram's Pi Workbench session.";
  return [
    `Topic: ${session.topic}`,
    `Phase: ${session.phase}`,
    `Agents: ${session.agents.join(", ")}`,
    `Rounds: ${session.rounds.length}`,
    `Updated: ${session.updatedAt}`,
  ].join("\n");
}
