import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireExclusiveLease, ExclusiveLeaseError, type ExclusiveLease } from "../exclusive-lease.ts";
import type { Exec, ExecResult } from "../types.ts";
import {
  registerWorkbenchUpdate,
  WorkbenchUpdater,
  type UpdateProfile,
  type WorkbenchApplyResult,
  type WorkbenchUpdateRunner,
  type WorkbenchUpdateStatus,
} from "../workbench-update.ts";

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRUSTED_REPOSITORY = "https://github.com/bsreeram08/pi-workbench.git";
const LEGACY_TRUSTED_REPOSITORY = "https://github.com/bsreeram08/pi-preference.git";
const TRUSTED_REPROMPTER = "https://github.com/AytuncYildizli/reprompter.git";
const roots: string[] = [];

function command(commandName: string, args: string[], cwd?: string): string {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${commandName} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
  return command("git", args, cwd);
}

async function temporaryRoot(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-update-"));
  const root = await fs.realpath(created);
  roots.push(root);
  return root;
}

function release(tag: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { draft: false, prerelease: false, tag_name: tag, ...overrides };
}

function fakeReleases(payload: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type RollbackCheckoutOperation = "preserve-failed-checkout" | "restore-checkout-snapshot";
type RollbackConfigOperation = "preserve-current" | "restore-original";

interface ExecControls {
  installerExit?: number;
  installerStderr?: string;
  installer?: (profile: UpdateProfile) => Promise<void> | void;
  candidateLsTreeOutput?: string;
  failFirstSubmoduleUpdate?: boolean;
  failPostverifyOnce?: boolean;
  afterFinalPreflight?: () => Promise<void> | void;
  afterMerge?: () => Promise<void> | void;
  beforePostverify?: () => Promise<void> | void;
  afterRollbackCheckoutAuthorization?: (operation: RollbackCheckoutOperation) => Promise<void> | void;
  afterRollbackConfigAuthorization?: (relativePath: string, operation: RollbackConfigOperation) => Promise<void> | void;
}

interface Fixture {
  root: string;
  agentDir: string;
  source: string;
  remote: string;
  initial: string;
  candidate: string;
  calls: Array<{ command: string; args: string[] }>;
  controls: ExecControls;
  exec: Exec;
  updater(fetchImpl: typeof fetch, profile?: UpdateProfile): WorkbenchUpdater;
  setProfile(profile: UpdateProfile): Promise<void>;
  pushMain(): void;
  tag(name: string, commit?: string, force?: boolean): void;
}

async function createFixture(profile: UpdateProfile = "default"): Promise<Fixture> {
  const base = await temporaryRoot();
  const subSource = path.join(base, "reprompter-source");
  const subRemote = path.join(base, "reprompter.git");
  const source = path.join(base, "source");
  const remote = path.join(base, "remote.git");
  const root = path.join(base, "checkout");
  const agentDir = path.join(base, "agent");

  await fs.mkdir(subSource, { recursive: true });
  git(subSource, "init", "-b", "main");
  git(subSource, "config", "user.name", "Updater Test");
  git(subSource, "config", "user.email", "updater@example.invalid");
  await fs.writeFile(path.join(subSource, "LICENSE"), "fixture license\n");
  git(subSource, "add", "LICENSE");
  git(subSource, "commit", "-m", "initial submodule");
  command("git", ["clone", "--bare", subSource, subRemote]);

  await fs.mkdir(source, { recursive: true });
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Updater Test");
  git(source, "config", "user.email", "updater@example.invalid");
  command("git", ["-c", "protocol.file.allow=always", "submodule", "add", subRemote, "reprompter"], source);
  await fs.writeFile(path.join(source, ".gitmodules"), `[submodule "reprompter"]\n\tpath = reprompter\n\turl = ${TRUSTED_REPROMPTER}\n`);
  await fs.writeFile(path.join(source, ".gitignore"), ".env\n.env.*\n.pi/\nsessions/\nnode_modules/\n");
  await fs.writeFile(path.join(source, "package.json"), '{"name":"pi-workbench","version":"1.0.0","private":true,"type":"module"}\n');
  await fs.writeFile(path.join(source, "install.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(source, "index.ts"), "export default function fixture() {}\n");
  await fs.mkdir(path.join(source, "setup", "themes"), { recursive: true });
  await fs.mkdir(path.join(source, "setup", "pi-look"), { recursive: true });
  await fs.mkdir(path.join(source, "scripts"), { recursive: true });
  await fs.cp(path.join(PROJECT_ROOT, "setup", "defaults"), path.join(source, "setup", "defaults"), { recursive: true });
  await fs.copyFile(path.join(PROJECT_ROOT, "scripts", "install-config.py"), path.join(source, "scripts", "install-config.py"));
  await fs.writeFile(path.join(source, "setup", "cmux-workbench.ts"), "fixture\n");
  await fs.writeFile(path.join(source, "setup", "pi-look", "index.ts"), "fixture\n");
  await fs.writeFile(path.join(source, "setup", "themes", "ember.json"), "{}\n");
  await fs.writeFile(path.join(source, "startup-header.ts"), "fixture\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  const initial = git(source, "rev-parse", "HEAD");
  command("git", ["clone", "--bare", source, remote]);
  git(source, "remote", "add", "publish", remote);
  command("git", ["clone", remote, root]);
  git(root, "config", "user.name", "Updater Test");
  git(root, "config", "user.email", "updater@example.invalid");
  git(root, "submodule", "init");
  git(root, "config", "submodule.reprompter.url", subRemote);
  command("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], root);
  git(root, "config", "submodule.reprompter.url", TRUSTED_REPROMPTER);
  git(path.join(root, "reprompter"), "remote", "set-url", "origin", TRUSTED_REPROMPTER);
  git(root, "remote", "set-url", "origin", TRUSTED_REPOSITORY);

  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "themes"), { recursive: true });
  await fs.symlink(root, path.join(agentDir, "extensions", "pi-workbench"));
  await fs.symlink(path.join(root, "setup", "cmux-workbench.ts"), path.join(agentDir, "extensions", "cmux-workbench.ts"));
  await fs.symlink(path.join(root, "setup", "pi-look"), path.join(agentDir, "extensions", "pi-look"));
  await fs.symlink(path.join(root, "setup", "themes", "ember.json"), path.join(agentDir, "themes", "ember.json"));
  await fs.symlink(path.join(root, "startup-header.ts"), path.join(agentDir, "extensions", "startup-header.ts"));
  await fs.writeFile(path.join(agentDir, "settings.json"), '{"fixture":true}\n', { mode: 0o640 });
  await fs.writeFile(path.join(agentDir, "user-profile.json"), '{"version":1,"preferences":[]}\n', { mode: 0o600 });
  await fs.mkdir(path.join(agentDir, "skill-evolution"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "skill-evolution", "config.json"), '{"version":1,"enabled":false,"trustedSources":[]}\n', { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "statusline.json"), '{"enabled":true}\n', { mode: 0o644 });

  const calls: Array<{ command: string; args: string[] }> = [];
  const controls: ExecControls = {};
  let failedSubmoduleUpdate = false;
  let failedPostverify = false;
  let finalPreflightHookRun = false;
  let mergeHookRun = false;
  let installerRan = false;
  let fixture!: Fixture;
  const exec: Exec = async (commandName, originalArgs) => {
    calls.push({ command: commandName, args: [...originalArgs] });
    if (commandName === path.join(root, "install.sh")) {
      installerRan = true;
      if (controls.installer) await controls.installer(profile);
      else applyCandidateConfig(fixture, profile);
      return { stdout: "installer output", stderr: controls.installerStderr ?? "", code: controls.installerExit ?? 0 };
    }
    let args = [...originalArgs];
    let gitArgs: string[] | undefined;
    if (commandName === "env") {
      const gitIndex = args.indexOf("git");
      if (gitIndex >= 0) {
        args.splice(gitIndex + 1, 0, "-c", `url.${subRemote}.insteadOf=${TRUSTED_REPROMPTER}`);
        const changesOrigin = originalArgs.includes("remote") && originalArgs.includes("set-url");
        args = args.map((value) => value === TRUSTED_REPOSITORY && !changesOrigin ? remote : value);
        gitArgs = args.slice(gitIndex + 1);
        const submoduleUpdate = gitArgs.includes("submodule") && gitArgs.includes("update");
        if (controls.candidateLsTreeOutput !== undefined && gitArgs.includes("ls-tree") && gitArgs.includes("reprompter")) {
          return { stdout: controls.candidateLsTreeOutput, stderr: "", code: 0 };
        }
        if (controls.failFirstSubmoduleUpdate && submoduleUpdate && !failedSubmoduleUpdate) {
          failedSubmoduleUpdate = true;
          return { stdout: "", stderr: "private submodule error", code: 1 };
        }
        if (controls.failPostverifyOnce && installerRan && !failedPostverify && gitArgs.includes("status")) {
          failedPostverify = true;
          return { stdout: "postverify failed", stderr: "", code: 0 };
        }
        if (controls.afterFinalPreflight && !finalPreflightHookRun && gitArgs.includes("merge") && gitArgs.includes("--ff-only")) {
          finalPreflightHookRun = true;
          await controls.afterFinalPreflight();
        }
      }
    }
    const result = spawnSync(commandName, args, { encoding: "utf8" });
    if (gitArgs && controls.afterMerge && !mergeHookRun && gitArgs.includes("merge") && gitArgs.includes("--ff-only") && result.status === 0) {
      mergeHookRun = true;
      await controls.afterMerge();
    }
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      code: result.status ?? 1,
      killed: result.signal !== null,
    } satisfies ExecResult;
  };

  fixture = {
    root,
    agentDir,
    source,
    remote,
    initial,
    candidate: "",
    calls,
    controls,
    exec,
    updater(fetchImpl, selectedProfile = profile) {
      profile = selectedProfile;
      return new WorkbenchUpdater({
        root,
        agentDir,
        exec,
        fetch: fetchImpl,
        now: () => new Date("2026-08-26T12:00:00.000Z"),
        createId: () => "11111111-1111-4111-8111-111111111111",
        afterInstallerSnapshot: () => controls.beforePostverify?.(),
        afterRollbackCheckoutAuthorization: (operation) => controls.afterRollbackCheckoutAuthorization?.(operation),
        afterRollbackConfigAuthorization: (relativePath, operation) => controls.afterRollbackConfigAuthorization?.(relativePath, operation),
        acquireLease: async (_leaseRoot, lockPath) => ({
          path: lockPath,
          owner: {} as ExclusiveLease["owner"],
          async release() {},
        }),
      });
    },
    async setProfile(selectedProfile) {
      profile = selectedProfile;
      const marker = path.join(agentDir, "update", "pi-workbench", "profile.json");
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, `${JSON.stringify({ version: 1, profile: selectedProfile }, null, 2)}\n`, { mode: 0o600 });
    },
    pushMain() {
      git(source, "push", "publish", "main");
    },
    tag(name, commit, force = false) {
      git(source, "tag", ...(force ? ["-f"] : []), name, ...(commit ? [commit] : []));
      git(source, "push", ...(force ? ["--force"] : []), "publish", `refs/tags/${name}`);
    },
  };

  await fixture.setProfile(profile);
  await fs.writeFile(path.join(source, "candidate.txt"), "candidate\n");
  await fs.writeFile(path.join(source, "package.json"), '{"name":"pi-workbench","version":"1.1.0","private":true,"type":"module"}\n');
  git(source, "add", "candidate.txt", "package.json");
  git(source, "commit", "-m", "candidate");
  fixture.candidate = git(source, "rev-parse", "HEAD");
  fixture.pushMain();
  fixture.tag("v1.1.0", fixture.candidate);
  return fixture;
}

async function embedSubmoduleMetadata(fixture: Fixture): Promise<string> {
  const checkout = path.join(fixture.root, "reprompter");
  const metadata = path.join(fixture.root, ".git", "modules", "reprompter");
  git(checkout, "config", "--unset-all", "core.worktree");
  await fs.unlink(path.join(checkout, ".git"));
  await fs.rename(metadata, path.join(checkout, ".git"));
  return path.join(checkout, ".git");
}

async function apply(updater: WorkbenchUpdater, confirm = true): Promise<WorkbenchApplyResult> {
  return updater.apply({
    confirm: async () => confirm,
    notify() {},
  });
}

async function commitInSource(fixture: Fixture, name: string, version: string): Promise<string> {
  await fs.writeFile(path.join(fixture.source, `${name}.txt`), `${name}\n`);
  await fs.writeFile(path.join(fixture.source, "package.json"), `{"name":"pi-workbench","version":"${version}","private":true,"type":"module"}\n`);
  git(fixture.source, "add", ".");
  git(fixture.source, "commit", "-m", name);
  return git(fixture.source, "rev-parse", "HEAD");
}

function applyCandidateConfig(fixture: Fixture, profile: UpdateProfile): void {
  const result = spawnSync("python3", [
    path.join(fixture.root, "scripts", "install-config.py"),
    "apply",
    "--agent-dir", fixture.agentDir,
    "--root", fixture.root,
    "--backup-root", path.join(fixture.agentDir, "live-installer-backup"),
    ...(profile === "full" ? ["--full"] : []),
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`candidate config apply failed: ${result.stderr}`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Pi Workbench updater status trust and channel policy", () => {
  test("selects the highest stable semver and never falls through to main once stable exists", async () => {
    const fixture = await createFixture();
    fixture.tag("v1.9.0", fixture.candidate);
    fixture.tag("v1.10.0", fixture.candidate);
    const mainOnly = await commitInSource(fixture, "future-main", "2.0.0");
    fixture.pushMain();

    const status = await fixture.updater(fakeReleases([
      release("v2.0.0-rc.1"),
      release("v1.9.0"),
      release("v1.10.0"),
      release("v9.0.0", { prerelease: true }),
    ])).status();

    expect(status).toMatchObject({ category: "update-available", channel: "stable", candidate: "v1.10.0", candidateCommit: fixture.candidate });
    expect(status.candidateCommit).not.toBe(mainOnly);
  });

  test("continues bounded release pagination before deciding that no stable release exists", async () => {
    const fixture = await createFixture();
    const requested: string[] = [];
    const pagedFetch: typeof fetch = async (input) => {
      requested.push(String(input));
      if (requested.length === 1) {
        return new Response(JSON.stringify([release("v2.0.0-rc.1")]), {
          status: 200,
          headers: { link: '<https://api.github.com/repositories/fixture/releases?page=2>; rel="next"' },
        });
      }
      return new Response(JSON.stringify([release("v1.1.0")]));
    };
    const status = await fixture.updater(pagedFetch).status();
    expect(status).toMatchObject({ category: "update-available", channel: "stable", candidate: "v1.1.0" });
    expect(requested).toHaveLength(2);
    expect(requested[1]?.endsWith("&page=2")).toBe(true);
  });

  test("selects hardcoded main when the API successfully has zero stable releases", async () => {
    const fixture = await createFixture();
    const status = await fixture.updater(fakeReleases([
      release("v2.0.0-rc.1"),
      release("v1.0.0", { draft: true }),
    ])).status();
    expect(status).toMatchObject({ category: "update-available", channel: "main", candidate: "main", candidateCommit: fixture.candidate });
    const fetchCall = fixture.calls.find((item) => item.command === "env" && item.args.includes("fetch"));
    expect(fetchCall?.args).toContain("+refs/heads/main:refs/pi-workbench-updater/candidate");
  });

  test("allows repeated trusted main updates while a later stable release still wins", async () => {
    const fixture = await createFixture();
    const emptyReleases = fakeReleases([]);
    expect(await apply(fixture.updater(emptyReleases))).toMatchObject({
      category: "updated",
      code: "UPDATED",
      channel: "main",
    });

    const nextMain = await commitInSource(fixture, "second-main", "1.2.0");
    fixture.pushMain();
    fixture.calls.length = 0;
    expect(await fixture.updater(emptyReleases).status()).toMatchObject({
      category: "update-available",
      code: "READY",
      channel: "main",
      candidateCommit: nextMain,
    });
    expect(fixture.calls.some((item) => item.args.includes("fetch"))).toBe(true);

    fixture.tag("v1.2.0", nextMain);
    expect(await fixture.updater(fakeReleases([release("v1.2.0")])).status()).toMatchObject({
      category: "update-available",
      code: "READY",
      channel: "stable",
      candidateCommit: nextMain,
    });
  }, 15_000);

  test("valid historical audit outcomes do not suppress later trusted main updates", async () => {
    const fixture = await createFixture();
    const emptyReleases = fakeReleases([]);
    const first = await apply(fixture.updater(emptyReleases));
    expect(first).toMatchObject({ category: "updated", channel: "main" });
    const auditPath = path.join(fixture.agentDir, "update", "pi-workbench", "audit.jsonl");
    const records = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const success = records.find((record) => record.outcome === "SUCCESS")!;
    await fs.appendFile(auditPath, `${JSON.stringify({
      ...success,
      timestamp: "2026-08-26T12:00:01.000Z",
      outcome: "ROLLED_BACK",
      checkoutRecovery: "FAILED_CHECKOUT_PRESERVED",
    })}\n`);

    const nextMain = await commitInSource(fixture, "main-after-rollback", "1.2.0");
    fixture.pushMain();
    expect(await fixture.updater(emptyReleases).status()).toMatchObject({
      category: "update-available",
      code: "READY",
      channel: "main",
      candidateCommit: nextMain,
    });
  });

  test("fails closed on malformed, symlinked, or oversized main-channel audit state", async () => {
    for (const kind of ["malformed", "symlink", "oversize"] as const) {
      const fixture = await createFixture();
      const auditPath = path.join(fixture.agentDir, "update", "pi-workbench", "audit.jsonl");
      if (kind === "malformed") await fs.writeFile(auditPath, "{bad json\n", { mode: 0o600 });
      if (kind === "oversize") await fs.writeFile(auditPath, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
      if (kind === "symlink") {
        const target = path.join(path.dirname(fixture.agentDir), "foreign-audit.jsonl");
        await fs.writeFile(target, "{}\n", { mode: 0o600 });
        await fs.symlink(target, auditPath);
      }
      fixture.calls.length = 0;
      expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "AUDIT_INVALID" });
      expect(fixture.calls.some((item) => item.args.includes("fetch"))).toBe(false);
    }
  }, 15_000);

  test("blocks release API failure, malformed payload, and oversized payload", async () => {
    const fixture = await createFixture();
    expect(await fixture.updater(fakeReleases({}, 200)).status()).toMatchObject({ category: "blocked", code: "RELEASES_MALFORMED" });
    expect(await fixture.updater(fakeReleases([], 429)).status()).toMatchObject({ category: "blocked", code: "RELEASES_UNAVAILABLE" });
    const oversized: typeof fetch = async () => new Response("x".repeat(256 * 1024 + 1), { status: 200 });
    expect(await fixture.updater(oversized).status()).toMatchObject({ category: "blocked", code: "RELEASES_OVERSIZE" });
  });

  test("categorizes equal, local-ahead, and divergent histories without downgrade", async () => {
    const equalFixture = await createFixture();
    git(equalFixture.root, "fetch", equalFixture.remote, "main");
    git(equalFixture.root, "merge", "--ff-only", "FETCH_HEAD");
    expect(await equalFixture.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({ category: "no-update", code: "EQUAL" });

    const aheadFixture = await createFixture();
    git(aheadFixture.root, "tag", "local-candidate", aheadFixture.initial);
    await fs.writeFile(path.join(aheadFixture.root, "ahead.txt"), "ahead\n");
    git(aheadFixture.root, "add", "ahead.txt");
    git(aheadFixture.root, "commit", "-m", "local ahead");
    aheadFixture.tag("v0.9.0", aheadFixture.initial);
    expect(await aheadFixture.updater(fakeReleases([release("v0.9.0")])).status()).toMatchObject({ category: "no-update", code: "AHEAD" });

    const divergentFixture = await createFixture();
    await fs.writeFile(path.join(divergentFixture.root, "local.txt"), "local\n");
    git(divergentFixture.root, "add", "local.txt");
    git(divergentFixture.root, "commit", "-m", "local divergent");
    expect(await divergentFixture.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({ category: "blocked", code: "DIVERGED" });
  });

  test("rejects hostile or multiple remotes, dirty state, linked worktrees, detached/non-main branches, and invalid profiles", async () => {
    const hostile = await createFixture();
    for (const url of [
      "https://user:secret@github.com/bsreeram08/pi-workbench.git",
      "http://github.com/bsreeram08/pi-workbench.git",
      "ssh://git@github.com/bsreeram08/pi-workbench.git",
      "git@github.com:bsreeram08/pi-workbench.git",
      "https://github.com:443/bsreeram08/pi-workbench.git",
      "https://github.com/bsreeram08/pi-workbench.git?ref=main",
      "https://github.com/bsreeram08/pi-workbench.git#main",
      "https://github.com/bsreeram08/pi%2dworkbench.git",
      "https://github.com\\bsreeram08\\pi-workbench.git",
      "https://www.github.com/bsreeram08/pi-workbench.git",
      "https://github.com/bsreeram08/other.git",
      "https://github.com/bsreeram08/pi-workbench.git//",
    ]) {
      git(hostile.root, "remote", "set-url", "origin", url);
      expect(await hostile.updater(fakeReleases([])).status()).toMatchObject({ code: "ORIGIN_UNTRUSTED" });
    }

    const multiple = await createFixture();
    git(multiple.root, "remote", "add", "evil", multiple.remote);
    expect(await multiple.updater(fakeReleases([])).status()).toMatchObject({ code: "ORIGIN_UNTRUSTED" });

    const dirty = await createFixture();
    await fs.writeFile(path.join(dirty.root, "untracked-secret.txt"), "secret\n");
    expect(await dirty.updater(fakeReleases([])).status()).toMatchObject({ code: "CHECKOUT_DIRTY" });

    const detached = await createFixture();
    git(detached.root, "checkout", "--detach");
    expect(await detached.updater(fakeReleases([])).status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });
    git(detached.root, "switch", "-c", "other");
    expect(await detached.updater(fakeReleases([])).status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });

    const linked = await createFixture();
    const linkedRoot = path.join(path.dirname(linked.root), "linked");
    git(linked.root, "worktree", "add", "-b", "linked-main", linkedRoot, "main");
    const linkedUpdater = new WorkbenchUpdater({ root: linkedRoot, agentDir: linked.agentDir, exec: linked.exec, fetch: fakeReleases([]) });
    expect(await linkedUpdater.status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });

    const marker = path.join(multiple.agentDir, "update", "pi-workbench", "profile.json");
    await fs.writeFile(marker, '{"version":1,"profile":"guessed"}\n');
    git(multiple.root, "remote", "remove", "evil");
    expect(await multiple.updater(fakeReleases([])).status()).toMatchObject({ code: "PROFILE_REQUIRED" });
    await fs.unlink(marker);
    expect(await multiple.updater(fakeReleases([])).status()).toMatchObject({ code: "PROFILE_REQUIRED" });
  }, 20_000);

  test("rejects multiple origin URLs including a configured push URL", async () => {
    const fixture = await createFixture();
    git(fixture.root, "config", "--add", "remote.origin.url", TRUSTED_REPOSITORY);
    const first = await fixture.updater(fakeReleases([])).status();
    expect(first).toMatchObject({ category: "blocked", code: "ORIGIN_UNTRUSTED" });

    git(fixture.root, "config", "--unset-all", "remote.origin.url");
    git(fixture.root, "config", "remote.origin.url", TRUSTED_REPOSITORY);
    git(fixture.root, "config", "remote.origin.pushurl", "https://github.com/attacker/repo.git");
    expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "ORIGIN_UNTRUSTED" });
  });

  test("runs every Git operation in a fixed clean environment with replacement and attribute protections", async () => {
    const fixture = await createFixture();
    expect((await fixture.updater(fakeReleases([release("v1.1.0")])).status()).code).toBe("READY");
    const gitCalls = fixture.calls.filter((item) => item.command === "env" && item.args.includes("git"));
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const call of gitCalls) {
      expect(call.args.slice(0, 2)).toEqual(["-i", `HOME=${os.homedir()}`]);
      expect(call.args).toContain("GIT_CONFIG_NOSYSTEM=1");
      expect(call.args).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      expect(call.args).toContain("GIT_NO_REPLACE_OBJECTS=1");
      expect(call.args).toContain("GIT_ATTR_NOSYSTEM=1");
      expect(call.args).toContain("--no-replace-objects");
      expect(call.args).toContain("core.attributesFile=/dev/null");
    }
    expect(fixture.calls.some((item) => item.command === "git")).toBe(false);
  });

  test("allows ordinary historical branch tracking config but rejects unsafe branch config", async () => {
    const safe = await createFixture();
    git(safe.root, "config", "branch.feat/example.remote", "origin");
    git(safe.root, "config", "branch.feat/example.merge", "refs/heads/feat/example");
    expect(await safe.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({
      category: "update-available",
      code: "READY",
    });

    for (const [key, value] of [
      ["branch.feat/example.remote", "attacker"],
      ["branch.feat/example.merge", "!touch /tmp/hostile"],
      ["branch.feat/.hidden.remote", "origin"],
      ["branch.feat/example.merge", "refs/heads/feat/.hidden"],
      ["branch.feat/example.rebase", "true"],
    ] as const) {
      const unsafe = await createFixture();
      git(unsafe.root, "config", key, value);
      expect(await unsafe.updater(fakeReleases([])).status()).toMatchObject({
        category: "blocked",
        code: "INSTALL_UNSUPPORTED",
      });
    }
  });

  test("rejects replace refs, grafts, info attributes, and unsafe execution or transport config", async () => {
    for (const setup of [
      async (fixture: Fixture) => {
        git(fixture.root, "fetch", fixture.remote, "refs/tags/v1.1.0");
        git(fixture.root, "update-ref", `refs/replace/${fixture.initial}`, fixture.candidate);
      },
      async (fixture: Fixture) => { await fs.writeFile(path.join(fixture.root, ".git", "info", "grafts"), `${fixture.initial} ${fixture.candidate}\n`); },
      async (fixture: Fixture) => { await fs.writeFile(path.join(fixture.root, ".git", "info", "attributes"), "* filter=hostile\n"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "url.https://attacker.invalid/.insteadOf", "https://github.com/"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "filter.hostile.clean", "touch /tmp/hostile"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "core.fsmonitor", "touch /tmp/hostile"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "submodule.reprompter.update", "!touch /tmp/hostile"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "credential.helper", "!touch /tmp/hostile"); },
      async (fixture: Fixture) => { git(fixture.root, "config", "http.proxy", "http://attacker.invalid"); },
      async (fixture: Fixture) => { git(path.join(fixture.root, "reprompter"), "config", "url.https://attacker.invalid/.insteadOf", "https://github.com/"); },
      async (fixture: Fixture) => { git(path.join(fixture.root, "reprompter"), "config", "filter.hostile.smudge", "touch /tmp/hostile"); },
    ]) {
      const fixture = await createFixture();
      await setup(fixture);
      expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });
    }
  }, 30_000);

  test("rejects missing or foreign installer-managed links for the selected profile", async () => {
    const missing = await createFixture();
    await fs.unlink(path.join(missing.agentDir, "extensions", "cmux-workbench.ts"));
    expect(await missing.updater(fakeReleases([])).status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });

    const foreign = await createFixture();
    const link = path.join(foreign.agentDir, "themes", "ember.json");
    await fs.unlink(link);
    await fs.symlink(path.join(foreign.agentDir, "settings.json"), link);
    expect(await foreign.updater(fakeReleases([])).status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });

    const full = await createFixture("full");
    await fs.unlink(path.join(full.agentDir, "extensions", "startup-header.ts"));
    expect(await full.updater(fakeReleases([]), "full").status()).toMatchObject({ code: "INSTALL_UNSUPPORTED" });
  });

  test("rejects candidates with missing or wrong-kind managed link targets", async () => {
    const missing = await createFixture("full");
    git(missing.source, "rm", "setup/cmux-workbench.ts", "startup-header.ts");
    git(missing.source, "commit", "-m", "remove managed sources");
    const missingCommit = git(missing.source, "rev-parse", "HEAD");
    missing.pushMain();
    missing.tag("v1.2.0", missingCommit);
    expect(await missing.updater(fakeReleases([release("v1.2.0")]), "full").status()).toMatchObject({
      category: "blocked",
      code: "CANDIDATE_INVALID",
    });

    const wrongKind = await createFixture();
    git(wrongKind.source, "rm", "-r", "setup/pi-look");
    await fs.writeFile(path.join(wrongKind.source, "setup", "pi-look"), "not a directory\n");
    git(wrongKind.source, "add", "setup/pi-look");
    git(wrongKind.source, "commit", "-m", "replace managed directory");
    const wrongKindCommit = git(wrongKind.source, "rev-parse", "HEAD");
    wrongKind.pushMain();
    wrongKind.tag("v1.2.0", wrongKindCommit);
    expect(await wrongKind.updater(fakeReleases([release("v1.2.0")])).status()).toMatchObject({
      category: "blocked",
      code: "CANDIDATE_INVALID",
    });
  });

  test("retains startup-header validation after full to default and rejects deletion or dangling candidates", async () => {
    const fixture = await createFixture("full");
    await fixture.setProfile("default");
    git(fixture.source, "rm", "startup-header.ts");
    git(fixture.source, "commit", "-m", "delete retained startup header");
    const candidate = git(fixture.source, "rev-parse", "HEAD");
    fixture.pushMain();
    fixture.tag("v1.2.0", candidate);

    expect(await fixture.updater(fakeReleases([release("v1.2.0")]), "default").status()).toMatchObject({
      category: "blocked",
      code: "CANDIDATE_INVALID",
    });
    expect((await fs.lstat(path.join(fixture.agentDir, "extensions", "startup-header.ts"))).isSymbolicLink()).toBe(true);
  });

  test("allows a fresh default install without startup-header and leaves a foreign startup path unmanaged", async () => {
    const fresh = await createFixture();
    await fs.unlink(path.join(fresh.agentDir, "extensions", "startup-header.ts"));
    expect(await fresh.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({ code: "READY" });

    const foreign = await createFixture();
    const startupPath = path.join(foreign.agentDir, "extensions", "startup-header.ts");
    await fs.unlink(startupPath);
    await fs.writeFile(startupPath, "user owned startup\n");
    expect(await foreign.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({ code: "READY" });
    expect(await fs.readFile(startupPath, "utf8")).toBe("user owned startup\n");
  });

  test("allows a fresh default profile candidate to omit an unlinked startup header", async () => {
    const fixture = await createFixture();
    await fs.unlink(path.join(fixture.agentDir, "extensions", "startup-header.ts"));
    git(fixture.source, "rm", "startup-header.ts");
    git(fixture.source, "commit", "-m", "remove unused startup header");
    const candidate = git(fixture.source, "rev-parse", "HEAD");
    fixture.pushMain();
    fixture.tag("v1.2.0", candidate);
    expect(await fixture.updater(fakeReleases([release("v1.2.0")])).status()).toMatchObject({
      category: "update-available",
      code: "READY",
      candidateCommit: candidate,
    });
  });

  test("accepts contained legacy submodule metadata", async () => {
    const fixture = await createFixture();
    const embeddedMetadata = await embedSubmoduleMetadata(fixture);

    expect(await fixture.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({
      category: "update-available",
      code: "READY",
    });

    git(fixture.root, "config", "--file", path.join(embeddedMetadata, "config"), "core.worktree", "");
    expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked" });
  });

  test("rejects nested submodules and external submodule metadata", async () => {
    const nested = await createFixture();
    await fs.writeFile(path.join(nested.root, "reprompter", ".gitmodules"), '[submodule "nested"]\n\tpath = nested\n\turl = https://github.com/attacker/nested.git\n');
    expect(await nested.updater(fakeReleases([])).status()).toMatchObject({ code: "SUBMODULE_DIRTY" });

    const external = await createFixture();
    const metadata = path.join(external.root, ".git", "modules", "reprompter");
    const moved = path.join(path.dirname(external.root), "external-reprompter-metadata");
    await fs.rename(metadata, moved);
    await fs.symlink(moved, metadata, "dir");
    expect(await external.updater(fakeReleases([])).status()).toMatchObject({ code: "SUBMODULE_DIRTY" });
  });

  test("rejects reprompter metadata grafts", async () => {
    const fixture = await createFixture();
    const metadata = path.join(fixture.root, ".git", "modules", "reprompter");
    const head = git(path.join(fixture.root, "reprompter"), "rev-parse", "HEAD");
    await fs.mkdir(path.join(metadata, "info"), { recursive: true });
    await fs.writeFile(path.join(metadata, "info", "grafts"), `${head}\n`);
    expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });
  });

  test("rejects reprompter metadata attributes", async () => {
    const fixture = await createFixture();
    const metadata = path.join(fixture.root, ".git", "modules", "reprompter");
    await fs.mkdir(path.join(metadata, "info"), { recursive: true });
    await fs.writeFile(path.join(metadata, "info", "attributes"), "* filter=hostile\n");
    expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });
  });

  test("rejects reprompter metadata replace refs", async () => {
    const fixture = await createFixture();
    const checkout = path.join(fixture.root, "reprompter");
    const head = git(checkout, "rev-parse", "HEAD");
    git(checkout, "update-ref", `refs/replace/${head}`, head);
    expect(await fixture.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });
  });

  test("rejects root and reprompter excludes that could hide untracked files", async () => {
    const rootExclude = await createFixture();
    await fs.writeFile(path.join(rootExclude.root, ".git", "info", "exclude"), "secret-*\n");
    expect(await rootExclude.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });

    const submoduleExclude = await createFixture();
    const metadata = path.join(submoduleExclude.root, ".git", "modules", "reprompter", "info");
    await fs.mkdir(metadata, { recursive: true });
    await fs.writeFile(path.join(metadata, "exclude"), "secret-*\n");
    expect(await submoduleExclude.updater(fakeReleases([])).status()).toMatchObject({ category: "blocked", code: "INSTALL_UNSUPPORTED" });
  });

  test("rejects an untrusted candidate .gitmodules before backup or checkout mutation", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.source, ".gitmodules"), '[submodule "reprompter"]\n\tpath = reprompter\n\turl = https://github.com/attacker/reprompter.git\n');
    git(fixture.source, "add", ".gitmodules");
    git(fixture.source, "commit", "-m", "hostile submodule mapping");
    const hostile = git(fixture.source, "rev-parse", "HEAD");
    fixture.pushMain();
    fixture.tag("v1.2.0", hostile);
    const result = await apply(fixture.updater(fakeReleases([release("v1.2.0")])));
    expect(result).toMatchObject({ category: "blocked", code: "UPDATE_FAILED", reload: false });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(await fs.readdir(path.join(fixture.agentDir, "backups", "update")).catch(() => [])).toEqual([]);
  });
});

describe("Pi Workbench updater apply transaction", () => {
  for (const profile of ["default", "full"] as const) {
    test(`uses exact ${profile} installer arguments and reload-eligible success`, async () => {
      const fixture = await createFixture(profile);
      let confirmation = "";
      const result = await fixture.updater(fakeReleases([release("v1.1.0")]), profile).apply({
        notify(message) { confirmation = message; },
        confirm: async (_title, message) => { confirmation = message; return true; },
      });
      expect(confirmation).toContain(fixture.initial);
      expect(confirmation).toContain(fixture.candidate);
      expect(confirmation).toContain(`Channel: stable`);
      expect(confirmation).toContain(`Profile: ${profile}`);
      expect(result).toMatchObject({ category: "updated", code: "UPDATED", reload: true, oldCommit: fixture.initial, newCommit: fixture.candidate });
      const install = fixture.calls.find((item) => item.command === path.join(fixture.root, "install.sh"));
      expect(install?.args).toEqual(profile === "full" ? ["--full"] : []);
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.candidate);
    }, 15_000);
  }

  test("accepts the legacy repository origin and migrates it only after a confirmed update", async () => {
    const successful = await createFixture();
    git(successful.root, "remote", "set-url", "origin", LEGACY_TRUSTED_REPOSITORY);
    expect(await successful.updater(fakeReleases([release("v1.1.0")])).status()).toMatchObject({
      category: "update-available",
      code: "READY",
    });
    expect(await apply(successful.updater(fakeReleases([release("v1.1.0")])))).toMatchObject({
      category: "updated",
      code: "UPDATED",
      reload: true,
    });
    expect(git(successful.root, "remote", "get-url", "origin")).toBe(TRUSTED_REPOSITORY);

    const failed = await createFixture();
    git(failed.root, "remote", "set-url", "origin", LEGACY_TRUSTED_REPOSITORY);
    failed.controls.installerExit = 1;
    expect(await apply(failed.updater(fakeReleases([release("v1.1.0")])))).toMatchObject({
      category: "blocked",
      code: "ROLLED_BACK",
      reload: false,
    });
    expect(git(failed.root, "remote", "get-url", "origin")).toBe(LEGACY_TRUSTED_REPOSITORY);
  }, 20_000);

  test.each(["before-migration", "after-install"] as const)("rejects origin replacement %s without clobbering it", async (stage) => {
    const fixture = await createFixture();
    const replacement = `https://github.com/attacker/${stage}.git`;
    const replaceOrigin = () => {
      git(fixture.root, "remote", "set-url", "origin", replacement);
    };
    if (stage === "before-migration") fixture.controls.afterMerge = replaceOrigin;
    else fixture.controls.beforePostverify = replaceOrigin;

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLED_BACK", reload: false });
    expect(git(fixture.root, "remote", "get-url", "origin")).toBe(TRUSTED_REPOSITORY);
    const manifest = JSON.parse(await fs.readFile(
      path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
      "utf8",
    )) as { recovery: { failedCheckout: string } };
    expect(git(manifest.recovery.failedCheckout, "remote", "get-url", "origin")).toBe(replacement);
  }, 20_000);

  test("preserves contained legacy submodule metadata through success and rollback", async () => {
    for (const failure of [false, true]) {
      const fixture = await createFixture();
      await embedSubmoduleMetadata(fixture);
      if (failure) fixture.controls.installerExit = 1;

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
      expect(result).toMatchObject(failure
        ? { category: "blocked", code: "ROLLED_BACK", reload: false }
        : { category: "updated", code: "UPDATED", reload: true });
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(failure ? fixture.initial : fixture.candidate);
      const embedded = await fs.lstat(path.join(fixture.root, "reprompter", ".git"));
      expect(embedded.isDirectory()).toBe(true);
      expect(embedded.isSymbolicLink()).toBe(false);
      expect(await fs.lstat(path.join(fixture.root, ".git", "modules", "reprompter")).catch(() => undefined)).toBeUndefined();
    }
  }, 30_000);

  test("keeps a concurrently changed old snapshot without rolling back a successful update", async () => {
    const fixture = await createFixture();
    const sentinel = Buffer.from("snapshot-cleanup-race\0sentinel\n");
    let snapshotSentinel = "";
    fixture.controls.installer = async () => {
      const transaction = (await fs.readdir(path.dirname(fixture.root))).find((name) => name.startsWith(".pi-workbench-update-"));
      if (!transaction) throw new Error("checkout snapshot transaction missing");
      snapshotSentinel = path.join(path.dirname(fixture.root), transaction, "checkout-snapshot", "cleanup-sentinel.bin");
      await fs.writeFile(snapshotSentinel, sentinel);
    };

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "updated", code: "UPDATED", reload: true });
    expect(await fs.readFile(snapshotSentinel)).toEqual(sentinel);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.candidate);
    const auditLines = (await fs.readFile(path.join(fixture.agentDir, "update", "pi-workbench", "audit.jsonl"), "utf8")).trim().split("\n");
    expect(auditLines).toHaveLength(2);
    expect(JSON.parse(auditLines[1]!)).toMatchObject({ event: "CHECKOUT_SNAPSHOT_CLEANUP", result: "RETAINED" });
  }, 10_000);

  test("cancellation leaves the checkout untouched and never runs the installer", async () => {
    const fixture = await createFixture();
    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])), false);
    expect(result).toMatchObject({ category: "blocked", code: "CANCELLED", reload: false });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(fixture.calls.some((item) => item.command === path.join(fixture.root, "install.sh"))).toBe(false);
  });

  test("recomputes and rejects a candidate that changes after confirmation without mutation", async () => {
    const fixture = await createFixture();
    const next = await commitInSource(fixture, "moved-tag", "1.2.0");
    fixture.pushMain();
    const updater = fixture.updater(fakeReleases([release("v1.1.0")]));
    const result = await updater.apply({
      notify() {},
      confirm: async () => {
        fixture.tag("v1.1.0", next, true);
        return true;
      },
    });
    expect(result).toMatchObject({ category: "blocked", code: "CANDIDATE_CHANGED", reload: false });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(await fs.readdir(path.join(fixture.agentDir, "backups", "update")).catch(() => [])).toEqual([]);
  });

  test("merges the immutable validated commit when the private ref changes after final preflight", async () => {
    const fixture = await createFixture();
    const moved = await commitInSource(fixture, "post-preflight-race", "1.2.0");
    fixture.pushMain();
    fixture.controls.afterFinalPreflight = () => {
      git(fixture.root, "fetch", fixture.remote, "main");
      git(fixture.root, "update-ref", "refs/pi-workbench-updater/candidate", moved);
    };
    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "updated", code: "UPDATED", newCommit: fixture.candidate });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.candidate);
    expect(await fs.access(path.join(fixture.root, "post-preflight-race.txt")).then(() => true, () => false)).toBe(false);
    const merge = fixture.calls.find((item) => item.command === "env" && item.args.includes("merge"));
    expect(merge?.args).toContain(fixture.candidate);
    expect(merge?.args).not.toContain("refs/pi-workbench-updater/candidate");
  });

  test("rejects candidate gitlink output unless it is one exact ls-tree record", async () => {
    const fixture = await createFixture();
    const submoduleHead = git(path.join(fixture.root, "reprompter"), "rev-parse", "HEAD");
    fixture.controls.candidateLsTreeOutput = `160000 commit ${submoduleHead}\treprompter\0unexpected`;
    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", reload: false });
    expect(result.code === "ROLLED_BACK" || result.code === "ROLLBACK_INCOMPLETE").toBe(true);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(fixture.calls.some((item) => item.command === path.join(fixture.root, "install.sh"))).toBe(false);
  });

  test("uses explicit checkout mode for every submodule update", async () => {
    const fixture = await createFixture();
    expect((await apply(fixture.updater(fakeReleases([release("v1.1.0")])))).code).toBe("UPDATED");
    const updates = fixture.calls.filter((item) => item.command === "env" && item.args.includes("submodule") && item.args.includes("update"));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((item) => item.args.includes("--checkout"))).toBe(true);
    expect(updates.every((item) => item.args.includes("--recursive"))).toBe(false);
  });

  test("blocks lock contention without fetching or waiting", async () => {
    const fixture = await createFixture();
    fixture.calls.length = 0;
    const updater = new WorkbenchUpdater({
      root: fixture.root,
      agentDir: fixture.agentDir,
      exec: fixture.exec,
      fetch: fakeReleases([release("v1.1.0")]),
      acquireLease: async () => { throw new ExclusiveLeaseError("writer_stale", "stale"); },
    });
    expect(await apply(updater)).toEqual({ category: "blocked", code: "LOCK_BLOCKED", reload: false });
    expect(fixture.calls).toEqual([]);
  });

  test("blocks before fetch or mutation when a workflow writer is active", async () => {
    const fixture = await createFixture();
    const writer = await acquireExclusiveLease(fixture.root, "start-work", { agentDir: fixture.agentDir });
    fixture.calls.length = 0;
    try {
      const updater = new WorkbenchUpdater({
        root: fixture.root,
        agentDir: fixture.agentDir,
        exec: fixture.exec,
        fetch: fakeReleases([release("v1.1.0")]),
      });
      expect(await apply(updater)).toEqual({ category: "blocked", code: "LOCK_BLOCKED", reload: false });
      expect(fixture.calls).toEqual([]);
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    } finally {
      await writer.release();
    }
  });

  test("rolls back a successful full installer that skips one required deterministic write", async () => {
    const fixture = await createFixture("full");
    const settingsPath = path.join(fixture.agentDir, "settings.json");
    const originalSettings = await fs.readFile(settingsPath);
    fixture.controls.installer = () => {
      applyCandidateConfig(fixture, "full");
      return fs.writeFile(settingsPath, originalSettings);
    };

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")]), "full"));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLED_BACK", reload: false });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(await fs.readFile(settingsPath)).toEqual(originalSettings);
  }, 15_000);

  test("rolls back installer, submodule, and postcheck failures and restores exact configuration", async () => {
    const scenarios = ["installer", "submodule", "postcheck"] as const;
    for (const scenario of scenarios) {
      const profile = scenario === "postcheck" ? "full" : "default";
      const fixture = await createFixture(profile);
      const marker = path.join(fixture.agentDir, "update", "pi-workbench", "profile.json");
      const settings = path.join(fixture.agentDir, "settings.json");
      const originalMarker = await fs.readFile(marker);
      const originalSettings = await fs.readFile(settings);
      const originalMode = (await fs.stat(settings)).mode & 0o777;
      if (scenario === "installer") fixture.controls.installerExit = 1;
      if (scenario === "submodule") fixture.controls.failFirstSubmoduleUpdate = true;
      if (scenario === "postcheck") {
        fixture.controls.installer = () => applyCandidateConfig(fixture, profile);
        fixture.controls.failPostverifyOnce = true;
      }

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")]), profile));
      expect(result).toMatchObject({ category: "blocked", code: "ROLLED_BACK", reload: false });
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
      expect(await fs.readFile(marker)).toEqual(originalMarker);
      expect(await fs.readFile(settings)).toEqual(originalSettings);
      expect((await fs.stat(settings)).mode & 0o777).toBe(originalMode);
    }
  }, 90_000);

  for (const scenario of ["tracked", "untracked", "config"] as const) {
    test(`preserves concurrent ${scenario} changes after the installer and reports rollback incomplete`, async () => {
      const fixture = await createFixture();
      const settings = path.join(fixture.agentDir, "settings.json");
      fixture.controls.installerExit = 1;
      let concurrentHookRan = false;
      fixture.controls.beforePostverify = async () => {
        concurrentHookRan = true;
        if (scenario === "tracked") await fs.writeFile(path.join(fixture.root, "candidate.txt"), "concurrent tracked\n");
        if (scenario === "untracked") await fs.writeFile(path.join(fixture.root, "concurrent.txt"), "concurrent untracked\n");
        if (scenario === "config") await fs.writeFile(settings, "concurrent config\n");
      };
      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
      expect(concurrentHookRan).toBe(true);
      expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
      const manifestPath = path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { recovery: { failedCheckout: string } };
      if (scenario === "tracked") expect(await fs.readFile(path.join(manifest.recovery.failedCheckout, "candidate.txt"), "utf8")).toBe("concurrent tracked\n");
      if (scenario === "untracked") expect(await fs.readFile(path.join(manifest.recovery.failedCheckout, "concurrent.txt"), "utf8")).toBe("concurrent untracked\n");
      if (scenario === "config") expect(await fs.readFile(settings, "utf8")).toBe("concurrent config\n");
      expect(await fs.stat(manifestPath)).toBeDefined();
    }, 30_000);
  }

  test("detects ignored checkout changes and preserves both old and live values", async () => {
    const fixture = await createFixture();
    const ignored = path.join(fixture.root, ".env");
    const original = Buffer.from("ORIGINAL_SECRET=before\n");
    const concurrent = Buffer.from("ORIGINAL_SECRET=changed-during-update\n");
    await fs.writeFile(ignored, original, { mode: 0o600 });
    fixture.controls.installerExit = 1;
    fixture.controls.installer = async () => { await fs.writeFile(ignored, concurrent, { mode: 0o600 }); };

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
    const manifest = JSON.parse(await fs.readFile(
      path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
      "utf8",
    )) as { recovery: { failedCheckout: string } };
    expect(await fs.readFile(ignored)).toEqual(original);
    expect(await fs.readFile(path.join(manifest.recovery.failedCheckout, ".env"))).toEqual(concurrent);
  });

  test("preserves tracked, untracked, and managed-config races after merge before state observation", async () => {
    for (const scenario of ["tracked", "untracked", "config"] as const) {
      const fixture = await createFixture();
      const settings = path.join(fixture.agentDir, "settings.json");
      const expected = Buffer.from(`pre-observation ${scenario}\0bytes\n`);
      fixture.controls.afterMerge = async () => {
        if (scenario === "tracked") await fs.writeFile(path.join(fixture.root, "candidate.txt"), expected);
        if (scenario === "untracked") await fs.writeFile(path.join(fixture.root, "concurrent.txt"), expected);
        if (scenario === "config") await fs.writeFile(settings, expected);
      };

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
      expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
      const manifest = JSON.parse(await fs.readFile(
        path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
        "utf8",
      )) as { recovery: { failedCheckout: string } };
      const pathname = scenario === "tracked"
        ? path.join(manifest.recovery.failedCheckout, "candidate.txt")
        : scenario === "untracked"
          ? path.join(manifest.recovery.failedCheckout, "concurrent.txt")
          : settings;
      expect(await fs.readFile(pathname)).toEqual(expected);
    }
  }, 30_000);

  test("preserves tracked, untracked, and managed-config edits made during the installer", async () => {
    for (const scenario of ["tracked", "untracked", "config"] as const) {
      const fixture = await createFixture();
      const settings = path.join(fixture.agentDir, "settings.json");
      const expected = Buffer.from(`during-installer ${scenario}\0bytes\n`);
      fixture.controls.installerExit = 1;
      fixture.controls.installer = async () => {
        if (scenario === "tracked") await fs.writeFile(path.join(fixture.root, "candidate.txt"), expected);
        if (scenario === "untracked") await fs.writeFile(path.join(fixture.root, "concurrent.txt"), expected);
        if (scenario === "config") await fs.writeFile(settings, expected);
      };

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
      expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
      const manifest = JSON.parse(await fs.readFile(
        path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
        "utf8",
      )) as { recovery: { failedCheckout: string } };
      const pathname = scenario === "tracked"
        ? path.join(manifest.recovery.failedCheckout, "candidate.txt")
        : scenario === "untracked"
          ? path.join(manifest.recovery.failedCheckout, "concurrent.txt")
          : settings;
      expect(await fs.readFile(pathname)).toEqual(expected);
    }
  }, 30_000);

  test("preserves checkout writes authorized immediately before each rollback rename", async () => {
    for (const scenario of ["tracked", "untracked", "submodule"] as const) {
      const fixture = await createFixture();
      fixture.controls.installerExit = 1;
      const sentinel = Buffer.from(`rollback-checkout-${scenario}\0sentinel\n`);
      let rollbackCallIndex = -1;
      fixture.controls.afterRollbackCheckoutAuthorization = async (operation) => {
        if (operation !== "preserve-failed-checkout") return;
        rollbackCallIndex = fixture.calls.length;
        if (scenario === "tracked") await fs.writeFile(path.join(fixture.root, "candidate.txt"), sentinel);
        if (scenario === "untracked") await fs.writeFile(path.join(fixture.root, "rollback-sentinel.txt"), sentinel);
        if (scenario === "submodule") await fs.writeFile(path.join(fixture.root, "reprompter", "LICENSE"), sentinel);
      };

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
      expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
      expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
      const manifest = JSON.parse(await fs.readFile(
        path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
        "utf8",
      )) as { recovery: { failedCheckout: string } };
      const recoveredPath = scenario === "tracked"
        ? path.join(manifest.recovery.failedCheckout, "candidate.txt")
        : scenario === "untracked"
          ? path.join(manifest.recovery.failedCheckout, "rollback-sentinel.txt")
          : path.join(manifest.recovery.failedCheckout, "reprompter", "LICENSE");
      expect(await fs.readFile(recoveredPath)).toEqual(sentinel);
      const rollbackCalls = fixture.calls.slice(rollbackCallIndex);
      expect(rollbackCalls.some((call) => call.args.includes("reset") || call.args.includes("clean") || call.args.includes("--force"))).toBe(false);
    }
  }, 30_000);

  test("does not overwrite a canonical checkout created during the rollback rename gap", async () => {
    const fixture = await createFixture();
    fixture.controls.installerExit = 1;
    const sentinel = Buffer.from("rename-gap\0sentinel\n");
    fixture.controls.afterRollbackCheckoutAuthorization = async (operation) => {
      if (operation !== "restore-checkout-snapshot") return;
      await fs.mkdir(fixture.root);
      await fs.writeFile(path.join(fixture.root, "concurrent.txt"), sentinel);
    };

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
    expect(await fs.readFile(path.join(fixture.root, "concurrent.txt"))).toEqual(sentinel);
    const manifest = JSON.parse(await fs.readFile(
      path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
      "utf8",
    )) as { recovery: { checkoutSnapshot: string; failedCheckout: string } };
    expect((await fs.lstat(manifest.recovery.checkoutSnapshot)).isDirectory()).toBe(true);
    expect((await fs.lstat(manifest.recovery.failedCheckout)).isDirectory()).toBe(true);
  });

  test("preserves config writes authorized before preserve and exclusive restore operations", async () => {
    for (const operation of ["preserve-current", "restore-original"] as const) {
      const fixture = await createFixture("full");
      const settings = path.join(fixture.agentDir, "settings.json");
      fixture.controls.installerExit = 1;
      fixture.controls.installer = () => applyCandidateConfig(fixture, "full");
      const sentinel = Buffer.from(`rollback-config-${operation}\0sentinel\n`);
      fixture.controls.afterRollbackConfigAuthorization = async (relativePath, currentOperation) => {
        if (relativePath === "settings.json" && currentOperation === operation) await fs.writeFile(settings, sentinel);
      };

      const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")]), "full"));
      expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
      expect(await fs.readFile(settings)).toEqual(sentinel);
      const manifest = JSON.parse(await fs.readFile(
        path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
        "utf8",
      )) as { recovery: { configValues: Record<string, string> } };
      if (operation === "restore-original") {
        expect(await fs.readFile(manifest.recovery.configValues["settings.json"]!)).not.toEqual(sentinel);
      }
    }
  }, 30_000);

  test("restores original absence after preserving an installer-created config value", async () => {
    const fixture = await createFixture("full");
    const statusline = path.join(fixture.agentDir, "statusline.json");
    await fs.unlink(statusline);
    fixture.controls.installerExit = 1;
    fixture.controls.installer = () => applyCandidateConfig(fixture, "full");

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")]), "full"));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLED_BACK", reload: false });
    expect(await fs.lstat(statusline).catch(() => undefined)).toBeUndefined();
    const manifest = JSON.parse(await fs.readFile(
      path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
      "utf8",
    )) as { recovery: { configValues: Record<string, string> } };
    expect((await fs.lstat(manifest.recovery.configValues["statusline.json"]!)).isFile()).toBe(true);
  }, 30_000);

  test("does not replace config created before exclusive restoration of an expected-absent file", async () => {
    const fixture = await createFixture();
    const settings = path.join(fixture.agentDir, "settings.json");
    const original = await fs.readFile(settings);
    const removingInstaller = [
      "import argparse, pathlib",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('action')",
      "parser.add_argument('--agent-dir', required=True)",
      "parser.add_argument('--root', required=True)",
      "parser.add_argument('--backup-root', required=True)",
      "parser.add_argument('--full', action='store_true')",
      "args = parser.parse_args()",
      "(pathlib.Path(args.agent_dir) / 'settings.json').unlink(missing_ok=True)",
      "",
    ].join("\n");
    await fs.writeFile(path.join(fixture.source, "scripts", "install-config.py"), removingInstaller);
    await fs.writeFile(path.join(fixture.source, "package.json"), '{"name":"pi-workbench","version":"1.2.0","private":true,"type":"module"}\n');
    git(fixture.source, "add", "scripts/install-config.py", "package.json");
    git(fixture.source, "commit", "-m", "expected absent config fixture");
    const candidate = git(fixture.source, "rev-parse", "HEAD");
    fixture.pushMain();
    fixture.tag("v1.2.0", candidate);
    fixture.controls.installerExit = 1;
    fixture.controls.installer = async () => { await fs.unlink(settings); };
    const sentinel = Buffer.from("expected-absent-create-race\0sentinel\n");
    fixture.controls.afterRollbackConfigAuthorization = async (relativePath, operation) => {
      if (relativePath === "settings.json" && operation === "restore-original") await fs.writeFile(settings, sentinel);
    };

    const result = await apply(fixture.updater(fakeReleases([release("v1.2.0")])));
    expect(result).toMatchObject({ category: "blocked", code: "ROLLBACK_INCOMPLETE", reload: false });
    expect(await fs.readFile(settings)).toEqual(sentinel);
    expect(await fs.readFile(path.join(fixture.agentDir, "backups", "update", result.backupId!, "config", "settings.json"))).toEqual(original);
  }, 30_000);

  test("stores the checkout snapshot beside an externally linked root on the same filesystem", async () => {
    const fixture = await createFixture();
    fixture.controls.installerExit = 1;
    const linkedRoot = path.join(fixture.agentDir, "extensions", "pi-workbench");
    const updater = new WorkbenchUpdater({
      root: linkedRoot,
      agentDir: fixture.agentDir,
      exec: fixture.exec,
      fetch: fakeReleases([release("v1.1.0")]),
      now: () => new Date("2026-08-26T12:00:00.000Z"),
      createId: () => "11111111-1111-4111-8111-111111111111",
      acquireLease: async (_leaseRoot, lockPath) => ({
        path: lockPath,
        owner: {} as ExclusiveLease["owner"],
        async release() {},
      }),
    });
    expect(updater.root).toBe(fixture.root);
    const result = await apply(updater);
    expect(result.backupId).toBeTruthy();
    expect(result.code === "ROLLED_BACK" || result.code === "ROLLBACK_INCOMPLETE").toBe(true);
    const manifest = JSON.parse(await fs.readFile(
      path.join(fixture.agentDir, "backups", "update", result.backupId!, "manifest.json"),
      "utf8",
    )) as { recovery: { transactionRoot: string; failedCheckout: string } };
    expect(path.dirname(manifest.recovery.transactionRoot)).toBe(path.dirname(fixture.root));
    expect((await fs.stat(manifest.recovery.failedCheckout)).dev).toBe((await fs.stat(fixture.root)).dev);
    expect(path.resolve(path.dirname(await fs.readlink(path.join(fixture.agentDir, "extensions", "pi-workbench"))), await fs.readlink(path.join(fixture.agentDir, "extensions", "pi-workbench")))).toBe(fixture.root);
  });

  test("rejects symlinked snapshot targets before mutation", async () => {
    const fixture = await createFixture();
    const settings = path.join(fixture.agentDir, "settings.json");
    const external = path.join(path.dirname(fixture.agentDir), "external-settings.json");
    await fs.writeFile(external, "external\n");
    await fs.unlink(settings);
    await fs.symlink(external, settings);
    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", reload: false });
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
    expect(await fs.readFile(external, "utf8")).toBe("external\n");
  });

  test("fails safely when audit.jsonl is a symlink without mutating its target or claiming success", async () => {
    const fixture = await createFixture();
    const auditDirectory = path.join(fixture.agentDir, "update", "pi-workbench");
    const sentinel = path.join(path.dirname(fixture.agentDir), "audit-sentinel");
    const original = Buffer.from("external audit sentinel\0bytes\n");
    await fs.writeFile(sentinel, original);
    await fs.symlink(sentinel, path.join(auditDirectory, "audit.jsonl"));

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", reload: false });
    expect(result.code === "ROLLED_BACK" || result.code === "ROLLBACK_INCOMPLETE").toBe(true);
    expect(await fs.readFile(sentinel)).toEqual(original);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
  });

  test("fails safely when audit.jsonl is non-regular without claiming success", async () => {
    const fixture = await createFixture();
    const auditPath = path.join(fixture.agentDir, "update", "pi-workbench", "audit.jsonl");
    await fs.mkdir(auditPath);

    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result).toMatchObject({ category: "blocked", reload: false });
    expect(result.code === "ROLLED_BACK" || result.code === "ROLLBACK_INCOMPLETE").toBe(true);
    expect((await fs.lstat(auditPath)).isDirectory()).toBe(true);
    expect(git(fixture.root, "rev-parse", "HEAD")).toBe(fixture.initial);
  });

  test("writes bounded categorical audit records without command output, prompts, URLs, or credentials", async () => {
    const fixture = await createFixture();
    fixture.controls.installerExit = 1;
    fixture.controls.installerStderr = "secret-token https://attacker.invalid arbitrary private failure";
    const result = await apply(fixture.updater(fakeReleases([release("v1.1.0")])));
    expect(result.code).toBe("ROLLED_BACK");
    const auditPath = path.join(fixture.agentDir, "update", "pi-workbench", "audit.jsonl");
    const text = await fs.readFile(auditPath, "utf8");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("attacker");
    expect(text).not.toContain(fixture.root);
    expect(text).not.toContain(fixture.agentDir);
    const record = JSON.parse(text.trim());
    expect(Object.keys(record).sort()).toEqual([
      "backupId", "candidateCommit", "channel", "checkoutRecovery", "configRecovery", "oldCommit", "outcome", "profile", "tag", "timestamp", "version",
    ]);
    expect(record.checkoutRecovery).toBe("FAILED_CHECKOUT_PRESERVED");
    expect(record.outcome).toBe("ROLLED_BACK");
    expect((await fs.stat(auditPath)).mode & 0o777).toBe(0o600);
  });
});

describe("/workbench-update command UX", () => {
  test("treats empty/status as status and rejects unknown actions or extra refs", async () => {
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    let statusCalls = 0;
    const updater = {
      async status(): Promise<WorkbenchUpdateStatus> {
        statusCalls += 1;
        return { category: "no-update", code: "EQUAL" };
      },
      async apply(): Promise<WorkbenchApplyResult> {
        throw new Error("must not apply");
      },
    } as WorkbenchUpdateRunner;
    registerWorkbenchUpdate({
      registerCommand(name: string, value: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, value.handler); },
    } as any, { root: "/fixture", exec: async () => ({ stdout: "", stderr: "", code: 0 }), updater });
    const notices: string[] = [];
    const ctx = { hasUI: true, ui: { notify(message: string) { notices.push(message); } } };

    await commands.get("workbench-update")!("", ctx);
    await commands.get("workbench-update")!("status", ctx);
    await commands.get("workbench-update")!("status refs/heads/evil", ctx);
    await commands.get("workbench-update")!("apply extra", ctx);
    expect(statusCalls).toBe(2);
    expect(notices.filter((item) => item.includes("INVALID_ACTION"))).toHaveLength(2);
  });

  test("success reports then reloads exactly once and reload is terminal", async () => {
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const events: string[] = [];
    const updater = {
      async status(): Promise<WorkbenchUpdateStatus> { return { category: "no-update", code: "EQUAL" }; },
      async apply(): Promise<WorkbenchApplyResult> {
        events.push("apply");
        return { category: "updated", code: "UPDATED", reload: true, oldCommit: "a".repeat(40), newCommit: "b".repeat(40) };
      },
    } as WorkbenchUpdateRunner;
    registerWorkbenchUpdate({
      registerCommand(name: string, value: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, value.handler); },
    } as any, { root: "/fixture", exec: async () => ({ stdout: "", stderr: "", code: 0 }), updater });
    const ctx = {
      hasUI: true,
      ui: {
        notify() { events.push("notify"); },
        async confirm() { events.push("confirm"); return true; },
      },
      async reload() { events.push("reload"); },
    };
    await commands.get("workbench-update")!("apply", ctx);
    expect(events).toEqual(["apply", "notify", "reload"]);
    expect(events.filter((item) => item === "reload")).toHaveLength(1);
  });

  test("prompts once on launch for an available trusted update and reloads only after confirmed success", async () => {
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
    let statusCalls = 0;
    let applyCalls = 0;
    const updater = {
      async status(): Promise<WorkbenchUpdateStatus> {
        statusCalls += 1;
        return { category: "update-available", code: "READY", candidateCommit: "b".repeat(40), channel: "main", candidate: "main" };
      },
      async apply(interaction: { confirm: (title: string, message: string) => Promise<boolean> }): Promise<WorkbenchApplyResult> {
        applyCalls += 1;
        expect(await interaction.confirm("Apply Pi Workbench update?", "candidate")).toBe(true);
        return { category: "updated", code: "UPDATED", reload: true, oldCommit: "a".repeat(40), newCommit: "b".repeat(40) };
      },
    } as WorkbenchUpdateRunner;
    registerWorkbenchUpdate({
      registerCommand(name: string, value: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, value.handler); },
      on(event: string, handler: (event: unknown, ctx: any) => void) { if (event === "session_start") sessionStart = handler; },
    } as any, { root: "/fixture", exec: async () => ({ stdout: "", stderr: "", code: 0 }), updater });
    const events: string[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify() { events.push("notify"); },
        async confirm() { events.push("confirm"); return true; },
      },
      async reload() { events.push("reload"); },
    };

    expect(sessionStart?.({}, ctx)).toBeUndefined();
    for (let attempt = 0; attempt < 50 && !events.includes("reload"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(events).toContain("confirm");
    expect(events).toContain("reload");
    expect(applyCalls).toBe(1);
    sessionStart?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statusCalls).toBe(2);
    expect(applyCalls).toBe(1);
  });

  test("abandons an in-flight startup check when its extension context shuts down", async () => {
    let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
    let sessionShutdown: (() => void) | undefined;
    let finishStatus!: (status: WorkbenchUpdateStatus) => void;
    let applyCalls = 0;
    const updater = {
      status: () => new Promise<WorkbenchUpdateStatus>((resolve) => { finishStatus = resolve; }),
      async apply(): Promise<WorkbenchApplyResult> {
        applyCalls += 1;
        return { category: "updated", code: "UPDATED", reload: true };
      },
    } as WorkbenchUpdateRunner;
    registerWorkbenchUpdate({
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: any) => void) {
        if (event === "session_start") sessionStart = handler;
        if (event === "session_shutdown") sessionShutdown = () => handler({}, {});
      },
    } as any, { root: "/fixture", exec: async () => ({ stdout: "", stderr: "", code: 0 }), updater });
    const ctx = { hasUI: true, ui: { notify() {}, async confirm() { throw new Error("stale context used"); } } };

    sessionStart?.({}, ctx);
    sessionShutdown?.();
    finishStatus({ category: "update-available", code: "READY", candidateCommit: "b".repeat(40), channel: "main" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(applyCalls).toBe(0);
  });

  test("reload rejection reports installed-on-disk restart guidance without claiming runtime load", async () => {
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const updater = {
      async status(): Promise<WorkbenchUpdateStatus> { return { category: "no-update", code: "EQUAL" }; },
      async apply(): Promise<WorkbenchApplyResult> {
        return { category: "updated", code: "UPDATED", reload: true, oldCommit: "a".repeat(40), newCommit: "b".repeat(40) };
      },
    } as WorkbenchUpdateRunner;
    registerWorkbenchUpdate({
      registerCommand(name: string, value: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, value.handler); },
    } as any, { root: "/fixture", exec: async () => ({ stdout: "", stderr: "", code: 0 }), updater });
    const notices: string[] = [];
    await commands.get("workbench-update")!("apply", {
      hasUI: true,
      ui: {
        notify(message: string) { notices.push(message); },
        async confirm() { return true; },
      },
      async reload() { throw new Error("reload rejected"); },
    });
    expect(notices.some((message) => message.includes("installed on disk") && message.includes("/reload") && message.includes("restart"))).toBe(true);
    expect(notices.some((message) => /runtime (?:is )?loaded/i.test(message))).toBe(false);
  });
});
