import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRunStore,
  computeAgentRunChecksum,
  digestAgentRunText,
  isAgentRunRecord,
  type AgentRunRecord,
} from "../agent-run-store.ts";

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-run-store-")));
  const project = path.join(root, "project");
  const storeRoot = path.join(root, "records");
  await fs.mkdir(project);
  return { root, project: await fs.realpath(project), store: new AgentRunStore(storeRoot) };
}

function record(project: string, sessions: string): Omit<AgentRunRecord, "checksum"> {
  return {
    version: 1,
    runId: "run-one",
    agentId: "planner",
    title: "Planner",
    projectRoot: project,
    cwd: project,
    groupId: "group-one",
    status: "queued",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    sequence: 0,
    taskDigest: digestAgentRunText("task"),
    systemPromptDigest: digestAgentRunText("prompt"),
    trustedCodeDigest: digestAgentRunText("code"),
    tools: ["read", "ask_parent"],
    readOnly: true,
    allowBash: false,
    sessionDir: sessions,
  };
}

describe("AgentRunStore", () => {
  test("writes and loads a private integrity-checked record", async () => {
    const item = await fixture();
    try {
      const paths = await item.store.prepare(item.project, "run-one");
      const saved = await item.store.save(paths, record(item.project, paths.sessions));
      expect(saved.checksum).toBe(computeAgentRunChecksum(saved));
      expect(isAgentRunRecord(saved)).toBe(true);
      await expect(item.store.load(item.project, "run-one")).resolves.toEqual(saved);
      if (process.platform !== "win32") {
        expect((await fs.stat(paths.record)).mode & 0o077).toBe(0);
        expect((await fs.stat(paths.root)).mode & 0o077).toBe(0);
      }
    } finally {
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("fails closed for altered and unknown fields", async () => {
    const item = await fixture();
    try {
      const paths = await item.store.prepare(item.project, "run-one");
      const saved = await item.store.save(paths, record(item.project, paths.sessions));
      await fs.writeFile(paths.record, `${JSON.stringify({ ...saved, status: "completed" })}\n`, { mode: 0o600 });
      await expect(item.store.load(item.project, "run-one")).rejects.toThrow("integrity validation");
      await fs.writeFile(paths.record, `${JSON.stringify({ ...saved, unexpected: true })}\n`, { mode: 0o600 });
      await expect(item.store.load(item.project, "run-one")).rejects.toThrow("integrity validation");
    } finally {
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("writes private final text and fails closed on digest mismatch", async () => {
    const item = await fixture();
    try {
      const paths = await item.store.prepare(item.project, "run-one");
      await item.store.writeFinalText(paths, "stored specialist output");
      const digest = digestAgentRunText("stored specialist output");
      await expect(item.store.loadFinalText(paths, digest)).resolves.toBe("stored specialist output");
      if (process.platform !== "win32") {
        expect((await fs.stat(paths.finalText)).mode & 0o077).toBe(0);
      }
      await expect(item.store.loadFinalText(paths, "a".repeat(64))).rejects.toThrow("digest check");
    } finally {
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked record", async () => {
    const item = await fixture();
    try {
      const paths = await item.store.prepare(item.project, "run-one");
      const outside = path.join(item.root, "outside.json");
      await fs.writeFile(outside, "{}", { mode: 0o600 });
      await fs.symlink(outside, paths.record);
      await expect(item.store.load(item.project, "run-one")).rejects.toThrow("Unsafe or oversized");
    } finally {
      await fs.rm(item.root, { recursive: true, force: true });
    }
  });
});
