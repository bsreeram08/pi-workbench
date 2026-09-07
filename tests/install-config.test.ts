import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "install-config.py");
const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-workbench-install-"));
  temporaryRoots.push(root);
  return root;
}

function cleanEnvironment(agentDir: string): NodeJS.ProcessEnv {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    TMPDIR: os.tmpdir(),
    PI_CODING_AGENT_DIR: agentDir,
    NO_COLOR: "1",
  };
}

function runConfig(action: "preflight" | "apply", agentDir: string, backupRoot?: string) {
  const args = [SCRIPT, action, "--agent-dir", agentDir, "--root", ROOT, "--full"];
  if (backupRoot) args.push("--backup-root", backupRoot);
  return spawnSync("python3", args, {
    cwd: ROOT,
    env: cleanEnvironment(agentDir),
    encoding: "utf8",
  });
}

function runRelationship(root: string, agentDir: string, targetExtension: string) {
  return spawnSync("python3", [
    SCRIPT,
    "relationship",
    "--agent-dir", agentDir,
    "--root", root,
    "--target-extension", targetExtension,
  ], {
    cwd: ROOT,
    env: cleanEnvironment(agentDir),
    encoding: "utf8",
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("public installer configuration safety", () => {
  test("full runtime installation works without checkout dependencies even when Bun and tsc are on PATH", async () => {
    const temp = await temporaryRoot();
    const checkout = path.join(temp, "checkout");
    const agentDir = path.join(temp, "agent");
    const bin = path.join(temp, "bin");
    await fs.cp(ROOT, checkout, { recursive: true, filter: (source) => {
      const parts = path.relative(ROOT, source).split(path.sep);
      return !parts.some((part) => ["node_modules", ".git", ".pi", ".agents", ".codex"].includes(part));
    } });
    await fs.mkdir(bin);
    for (const tool of ["bun", "tsc"]) {
      await fs.writeFile(path.join(bin, tool), "#!/bin/sh\necho unexpected-development-check >&2\nexit 97\n", { mode: 0o755 });
    }
    const result = spawnSync("bash", [path.join(checkout, "install.sh"), "--full"], {
      cwd: checkout, encoding: "utf8", timeout: 60_000,
      env: { ...cleanEnvironment(agentDir), PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Native user-profile command discovery passed");
    expect(result.stderr).not.toContain("unexpected-development-check");
    expect(await fs.realpath(path.join(agentDir, "extensions", "startup-header.ts"))).toBe(await fs.realpath(path.join(checkout, "startup-header.ts")));
    expect(await fs.realpath(path.join(agentDir, "extensions", "pi-workbench"))).toBe(await fs.realpath(checkout));
    expect(await fs.stat(path.join(checkout, "node_modules")).catch(() => undefined)).toBeUndefined();
  }, 90_000);

  test("fails closed on malformed existing JSON without mutating the installation", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    const settingsPath = path.join(agentDir, "settings.json");
    const original = Buffer.from('{"theme":');
    await fs.writeFile(settingsPath, original);

    const result = spawnSync("bash", [path.join(ROOT, "install.sh"), "--full"], {
      cwd: ROOT,
      env: cleanEnvironment(agentDir),
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid JSON");
    expect(await fs.readFile(settingsPath)).toEqual(original);
    expect(await fs.stat(path.join(agentDir, "extensions")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(agentDir, "backups")).catch(() => undefined)).toBeUndefined();
  });

  test("backs up and merges the explicitly requested opinionated profile", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const evolutionDir = path.join(agentDir, "skill-evolution");
    const backupRoot = path.join(root, "backup");
    await fs.mkdir(evolutionDir, { recursive: true });

    const originalSettings = '{"theme":"custom","defaultProvider":"openrouter","defaultModel":"x-ai/grok-4.6","defaultThinkingLevel":"medium","customSetting":true}\n';
    const originalProfile = '{"version":1,"preferences":[{"id":"local","statement":"Keep local."}]}\n';
    const originalEvolution = '{"version":1,"enabled":false,"trustedSources":[]}\n';
    await fs.writeFile(path.join(agentDir, "settings.json"), originalSettings);
    await fs.writeFile(path.join(agentDir, "user-profile.json"), originalProfile);
    await fs.writeFile(path.join(evolutionDir, "config.json"), originalEvolution);

    expect(runConfig("preflight", agentDir).status).toBe(0);
    const applied = runConfig("apply", agentDir, backupRoot);
    expect(applied.status).toBe(0);

    const settings = JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf8"));
    const profile = JSON.parse(await fs.readFile(path.join(agentDir, "user-profile.json"), "utf8"));
    const evolution = JSON.parse(await fs.readFile(path.join(evolutionDir, "config.json"), "utf8"));
    expect(settings).toEqual({
      theme: "ember",
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.6-sol",
      defaultThinkingLevel: "high",
      quietStartup: true,
      customSetting: true,
    });
    expect(profile.preferences.some((item: { id: string }) => item.id === "local")).toBe(true);
    expect(profile.preferences.length).toBeGreaterThan(1);
    expect(evolution.enabled).toBe(false);
    expect(evolution.trustedSources.map((item: { source: string }) => item.source)).toEqual([
      "mattpocock/skills",
      "emilkowalski/skills",
    ]);
    expect(await fs.readFile(path.join(backupRoot, "config", "settings.json"), "utf8")).toBe(originalSettings);
    expect(await fs.readFile(path.join(backupRoot, "config", "user-profile.json"), "utf8")).toBe(originalProfile);
    expect(await fs.readFile(path.join(backupRoot, "config", "skill-evolution-config.json"), "utf8")).toBe(originalEvolution);
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "update", "pi-workbench", "profile.json"), "utf8"))).toEqual({ version: 1, profile: "full" });

    const repeated = runConfig("apply", agentDir, backupRoot);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("already current");
  });

  test("rejects replacing a primary checkout from its linked worktree", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const target = path.join(agentDir, "extensions", "pi-workbench");
    const worktree = path.join(root, "feature-worktree");
    const gitDir = path.join(target, ".git", "worktrees", "feature-worktree");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);

    const blocked = runRelationship(worktree, agentDir, target);
    expect(blocked.status).toBe(3);
    expect(blocked.stdout).toContain("depends on the target extension's Git metadata");

    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(root, "independent", ".git")}\n`);
    const safe = runRelationship(worktree, agentDir, target);
    expect(safe.status).toBe(0);
    expect(safe.stdout).toContain("worktree relationship: safe");
  });

  test("rejects symlinked configuration paths", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const external = path.join(root, "external-settings.json");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(external, "{}\n");
    await fs.symlink(external, path.join(agentDir, "settings.json"));

    const result = runConfig("preflight", agentDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be a symbolic link");
    expect(await fs.readFile(external, "utf8")).toBe("{}\n");
  });

  // This exercises the complete installer subprocess and can exceed Bun's 5 s
  // default test timeout on a loaded macOS CI runner.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("restores replaced resources when a later link fails", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const binDir = path.join(root, "bin");
    const extensionsDir = path.join(agentDir, "extensions");
    const themesDir = path.join(agentDir, "themes");
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.mkdir(themesDir, { recursive: true });

    const locate = (name: string) => {
      const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Missing test executable: ${name}`);
      return result.stdout.trim();
    };
    const locateNode = async () => {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, "node");
        try {
          const stat = await fs.lstat(candidate);
          if (!stat.isFile() && !stat.isSymbolicLink()) continue;
          const real = await fs.realpath(candidate);
          if (!/bun/i.test(path.basename(real))) return candidate;
        } catch {
          // Missing PATH entry.
        }
      }
      return process.execPath;
    };
    await fs.symlink(await locateNode(), path.join(binDir, "node"));
    await fs.symlink(locate("python3"), path.join(binDir, "python3"));
    await fs.symlink(locate("pi"), path.join(binDir, "pi"));
    await fs.writeFile(path.join(extensionsDir, "pi-workbench"), "original-extension\n");
    await fs.writeFile(path.join(extensionsDir, "cmux-workbench.ts"), "original-cmux-workbench\n");
    await fs.writeFile(path.join(extensionsDir, "pi-look"), "original-look\n");
    await fs.writeFile(path.join(extensionsDir, "startup-header.ts"), "original-header\n");
    await fs.chmod(themesDir, 0o500);

    let result;
    try {
      result = spawnSync("bash", [path.join(ROOT, "install.sh")], {
        cwd: ROOT,
        env: {
          ...cleanEnvironment(agentDir),
          PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
        encoding: "utf8",
      });
    } finally {
      await fs.chmod(themesDir, 0o700);
    }

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring replaced links");
    expect(await fs.readFile(path.join(extensionsDir, "pi-workbench"), "utf8")).toBe("original-extension\n");
    expect(await fs.readFile(path.join(extensionsDir, "cmux-workbench.ts"), "utf8")).toBe("original-cmux-workbench\n");
    expect(await fs.readFile(path.join(extensionsDir, "pi-look"), "utf8")).toBe("original-look\n");
    expect(await fs.readFile(path.join(extensionsDir, "startup-header.ts"), "utf8")).toBe("original-header\n");
    expect((await fs.lstat(path.join(extensionsDir, "pi-workbench"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(extensionsDir, "cmux-workbench.ts"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(extensionsDir, "pi-look"))).isSymbolicLink()).toBe(false);
    expect((await fs.lstat(path.join(extensionsDir, "startup-header.ts"))).isSymbolicLink()).toBe(false);
  }, 20_000);

  test("records the default profile without changing unrelated configuration", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const backupRoot = path.join(root, "backup");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "settings.json"), '{"theme":"custom"}\n');
    const result = spawnSync("python3", [
      SCRIPT,
      "apply",
      "--agent-dir", agentDir,
      "--root", ROOT,
      "--backup-root", backupRoot,
    ], {
      cwd: ROOT,
      env: cleanEnvironment(agentDir),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(agentDir, "settings.json"), "utf8")).toBe('{"theme":"custom"}\n');
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "update", "pi-workbench", "profile.json"), "utf8"))).toEqual({ version: 1, profile: "default" });
  });

  test("rejects a symlinked updater profile directory", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const external = path.join(root, "external-update");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.symlink(external, path.join(agentDir, "update"));
    const result = spawnSync("python3", [SCRIPT, "preflight", "--agent-dir", agentDir, "--root", ROOT], {
      cwd: ROOT,
      env: cleanEnvironment(agentDir),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("configuration parent must be a real directory");
    expect(await fs.readdir(external)).toEqual([]);
  });

  test("backs up the previous profile marker before atomically replacing it", async () => {
    const root = await temporaryRoot();
    const agentDir = path.join(root, "agent");
    const marker = path.join(agentDir, "update", "pi-workbench", "profile.json");
    const backupRoot = path.join(root, "backup");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    const previous = '{"version":1,"profile":"default"}\n';
    await fs.writeFile(marker, previous, { mode: 0o640 });

    const result = runConfig("apply", agentDir, backupRoot);
    expect(result.status).toBe(0);
    expect(await fs.readFile(path.join(backupRoot, "config", "profile.json"), "utf8")).toBe(previous);
    expect(JSON.parse(await fs.readFile(marker, "utf8"))).toEqual({ version: 1, profile: "full" });
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
  });
});
