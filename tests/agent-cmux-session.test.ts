import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { categoricalAgentTitle, CmuxAgentSessionHost, createCmuxAgentSessionHost } from "../agent-cmux-session.ts";
import { BoundedJsonlDecoder, MAX_CHILD_BRIDGE_FRAME_BYTES } from "../agent-child-bridge.ts";
import type { AgentRunPaths } from "../agent-run-store.ts";

async function privatePaths(root: string): Promise<AgentRunPaths> {
  const paths = {
    root,
    record: path.join(root, "record.json"),
    systemPrompt: path.join(root, "system-prompt.md"),
    finalText: path.join(root, "final-text.md"),
    sessions: path.join(root, "sessions"),
    temporaryHome: path.join(root, "home"),
    temporaryDirectory: path.join(root, "tmp"),
  };
  await Promise.all([root, paths.sessions, paths.temporaryHome, paths.temporaryDirectory].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  return paths;
}

describe("cmux interactive agent session host", () => {
  test("prepares a private bridge contract and focuses only the recorded surface", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-session-host-"));
    const paths = await privatePaths(path.join(root, "run"));
    const commands: string[][] = [];
    const runner = async (args: readonly string[]) => { commands.push([...args]); return { ok: true, stdout: "OK\n", stderr: "" }; };
    try {
      const host = new CmuxAgentSessionHost({
        HOME: root, PATH: "/usr/bin", CMUX_WORKSPACE_ID: "workspace:7", CMUX_SURFACE_ID: "surface:9",
        CMUX_SOCKET_PASSWORD: "socket-capability",
      }, runner);
      const prepared = await host.prepare({
        runId: "run-one", agentId: "constructor", paths, projectRoot: root, task: "Review constructor behavior",
        piInvocation: { command: "/usr/bin/pi", args: ["--session-dir", paths.sessions, "--extension", "/trusted/child.ts"] },
        childEnvironment: { PATH: "/usr/bin", HOME: paths.temporaryHome },
      });
      expect(prepared.invocation.args).toEqual([expect.stringContaining("agent-cmux-bridge.mjs"), path.join(paths.root, "cmux-bridge.json")]);
      expect(prepared.environment.CMUX_SOCKET_PASSWORD).toBe("socket-capability");
      const contract = JSON.parse(await fs.readFile(path.join(paths.root, "cmux-bridge.json"), "utf8"));
      expect(contract).toMatchObject({
        version: 1,
        runId: "run-one",
        title: expect.stringContaining("· Review constructor behavior"),
        description: "Specialist: Review constructor behavior",
        projectRoot: root,
      });
      expect(contract.authToken).toMatch(/^[0-9a-f]{64}$/);
      expect(contract.socketPath.length).toBeLessThan(100);
      expect(path.dirname(contract.socketPath)).toBe(os.tmpdir());
      expect((await fs.lstat(path.join(paths.root, "cmux-bridge.json"))).mode & 0o077).toBe(0);

      await fs.writeFile(path.join(paths.root, "cmux-surface.json"), JSON.stringify({
        version: 1, runId: "run-one", workspace: "workspace:7", pane: "pane:4", surface: "surface:11",
      }), { mode: 0o600 });
      host.focus("run-one");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(commands).toContainEqual([
        "move-surface", "--surface", "surface:11", "--pane", "pane:4", "--workspace", "workspace:7", "--focus", "true",
      ]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("uses fixed allowlisted titles and rejects missing or malformed cmux identity", () => {
    expect(categoricalAgentTitle("researcher")).toBe("Researcher");
    for (const value of ["dynamic-secret", "constructor", "toString", "__proto__"]) expect(categoricalAgentTitle(value)).toBe("Specialist");
    expect(createCmuxAgentSessionHost({})).toBeUndefined();
    expect(() => createCmuxAgentSessionHost({ CMUX_WORKSPACE_ID: "workspace:bad", CMUX_SURFACE_ID: "surface:1" })).toThrow("malformed");
    expect(() => createCmuxAgentSessionHost({ CMUX_SOCKET_PATH: "/private/cmux.sock" })).toThrow("missing or malformed");
    expect(createCmuxAgentSessionHost({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:2" })).toBeDefined();
  });

  test("auth/control JSONL framing stays LF-delimited and bounded", () => {
    const decoder = new BoundedJsonlDecoder(64);
    expect(decoder.push('{"type":"command"')).toEqual([]);
    expect(decoder.push(',"id":"one"}\n')).toEqual([{ type: "command", id: "one" }]);
    expect(new BoundedJsonlDecoder(8).push("{}\n{}\n{}\n")).toEqual([{}, {}, {}]);
    expect(() => new BoundedJsonlDecoder(8).push("123456789")).toThrow("byte limit");
    expect(MAX_CHILD_BRIDGE_FRAME_BYTES).toBe(4 * 1024 * 1024);
  });
});
