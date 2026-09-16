import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { instinctsRoot, renderInstinctL1, WorkbenchInstinctStore } from "../instinct-store.ts";
import { registerWorkbenchInstincts } from "../instincts.ts";

async function fixture(prefix: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await fs.mkdir(agentDir);
  await fs.mkdir(project);
  return { root, agentDir, project, store: new WorkbenchInstinctStore(agentDir, project) };
}

describe("Workbench instincts", () => {
  test("stores instincts outside the project and injects only confident hints", async () => {
    const { root, agentDir, project, store } = await fixture("workbench-instincts-");
    try {
      expect(instinctsRoot(agentDir, project).startsWith(project + path.sep)).toBe(false);
      const testing = await store.retain({
        trigger: "adding a feature",
        action: "write a failing test first",
        domain: "testing",
        evidence: "User corrected implementation-first during review.",
      });
      expect(testing.confidence).toBe(0.6);
      const low = await store.retain({
        trigger: "naming CSS tokens",
        action: "prefer semantic names",
        domain: "code-style",
        evidence: "One mention in passing.",
        confidence: 0.3,
      });
      expect(low.confidence).toBe(0.3);
      const injected = await store.recall("feature test", { inject: true });
      expect(injected).toHaveLength(1);
      expect(injected[0].action).toContain("failing test");
      const l1 = renderInstinctL1(injected);
      expect(l1).toContain("not instructions");
      expect(l1).toContain("testing");
      const files = await fs.readdir(instinctsRoot(agentDir, project));
      expect(files.every((name) => name.endsWith(".json"))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("duplicate retain reinforces, contradict lowers confidence, forget removes", async () => {
    const { root, store } = await fixture("workbench-instincts-lifecycle-");
    try {
      const first = await store.retain({
        trigger: "editing TypeScript",
        action: "prefer edit over rewrite",
        domain: "workflow",
        evidence: "User rejected a full file rewrite.",
      });
      const again = await store.retain({
        trigger: "editing TypeScript",
        action: "prefer edit over rewrite",
        domain: "workflow",
        evidence: "User rejected another rewrite.",
      });
      expect(again.id).toBe(first.id);
      expect(again.confidence).toBe(0.7);
      expect(again.observations).toBe(2);
      const contradicted = await store.contradict(first.id, "User asked for a clean rewrite this time.");
      expect(contradicted.confidence).toBe(0.5);
      await store.forget(first.id);
      expect(await store.recall()).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects secrets, skips corrupt files, and keeps global instincts separate", async () => {
    const { root, agentDir, project, store } = await fixture("workbench-instincts-safety-");
    try {
      await expect(store.retain({
        trigger: "calling the API",
        action: "include the token",
        evidence: "API key = sk-testfixture-abcdefghijklmnopqrstuvwxyz123456",
      })).rejects.toThrow("credential or secret");
      await store.retain({
        trigger: "committing",
        action: "use conventional commits",
        domain: "git",
        scope: "global",
        evidence: "Repeated across two projects.",
      });
      expect((await store.status()).global).toBe(1);
      expect((await store.recall(undefined, { inject: true }))).toEqual([]);
      const directory = instinctsRoot(agentDir, project);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, "broken.json"), "{not-json", "utf8");
      expect(await store.recall()).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("registers recall/retain tools and a status command without throwing on missing store", async () => {
    const tools: Array<{ name: string }> = [];
    const commands = new Map<string, (args: string, ctx: { cwd: string }) => Promise<void>>();
    const reports: string[] = [];
    registerWorkbenchInstincts({
      on() {},
      registerTool(tool: { name: string }) { tools.push(tool); },
      registerCommand(name: string, command: { handler: (args: string, ctx: { cwd: string }) => Promise<void> }) {
        commands.set(name, command.handler);
      },
    } as never, {
      exec: async () => ({ stdout: "/missing-project\n", stderr: "", code: 0 }),
      report: (_title, body) => reports.push(body),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["workbench_instincts"]);
    await commands.get("instincts")?.("", { cwd: "/missing-project" });
    expect(reports.at(-1)).toContain("No injectable instincts yet.");
  });
});
