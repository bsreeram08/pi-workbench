import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTaskModelPolicy, resolveTaskModel, setTaskModelPreference } from "../task-model-policy.ts";
import type { WorkflowPaths } from "../workflow-state.ts";

const roots: string[] = [];
const binding = { id: "plan-one", task: "Build the portfolio" };
const model = "openai-codex/gpt-6-astra:high";
async function fixture(): Promise<WorkflowPaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-model-policy-"));
  roots.push(root);
  const workflow = path.join(root, ".pi", "pi-workbench", "workflow");
  return { root: workflow, current: path.join(workflow, "current.json"), plans: path.join(workflow, "plans"), runs: path.join(workflow, "runs") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("task model preferences", () => {
  test("exact domain choice survives reload and related actions without changing unrelated domains", async () => {
    const paths = await fixture();
    await setTaskModelPreference(paths, binding, { domain: "ui-ux", actions: ["implement", "repair", "review", "plan-review"], model, reason: "Use Astra for UI work and its reviews" });
    const reloaded = await readTaskModelPolicy(paths, binding);
    for (const action of ["implement", "repair", "review", "plan-review"] as const) {
      expect(resolveTaskModel(reloaded, { domain: "ui-ux", action })).toBe(model);
      expect(() => resolveTaskModel(reloaded, { domain: "ui-ux", action, model: "openai-codex/gpt-5.6-luna" })).toThrow("pinned");
      expect(() => resolveTaskModel(reloaded, { action })).toThrow("domain");
    }
    expect(resolveTaskModel(reloaded, { domain: "backend", action: "implement" })).toBeUndefined();
    expect(await readTaskModelPolicy(paths, { ...binding, id: "new-plan" })).toBeNull();
    expect(await readTaskModelPolicy(paths, { ...binding, task: "A different task" })).toBeNull();
  });

  test("explicit replacement changes only selected actions and preserves the remaining pin", async () => {
    const paths = await fixture();
    await setTaskModelPreference(paths, binding, { domain: "ui-ux", actions: ["implement", "review"], model, reason: "Astra for UI" });
    const replacement = { domain: "ui-ux", actions: ["review"] as const, model: "openai-codex/gpt-5.6-sol:high", reason: "Use Sol for review" };
    await expect(setTaskModelPreference(paths, binding, { ...replacement, actions: [...replacement.actions] })).rejects.toThrow("replacement");
    const policy = await setTaskModelPreference(paths, binding, { ...replacement, actions: [...replacement.actions], replace: true });
    expect(resolveTaskModel(policy, { domain: "ui-ux", action: "implement" })).toBe(model);
    expect(resolveTaskModel(policy, { domain: "ui-ux", action: "review" })).toBe(replacement.model);
  });

  test("malformed, oversized, linked, and directory policies fail closed", async () => {
    const paths = await fixture();
    await fs.mkdir(paths.root, { recursive: true });
    const filename = path.join(paths.root, "task-model-policy.json");
    for (const content of ["{", " ".repeat(32_769), JSON.stringify({ version: 1 })]) {
      await fs.writeFile(filename, content);
      await expect(readTaskModelPolicy(paths, binding)).rejects.toThrow();
    }
    await fs.unlink(filename);
    const outside = path.join(roots.at(-1)!, "outside");
    await fs.writeFile(outside, "{}");
    await fs.symlink(outside, filename);
    await expect(readTaskModelPolicy(paths, binding)).rejects.toThrow("safely opened");
    await fs.unlink(filename);
    await fs.link(outside, filename);
    await expect(readTaskModelPolicy(paths, binding)).rejects.toThrow("regular file");
    await fs.unlink(filename);
    await fs.mkdir(filename);
    await expect(readTaskModelPolicy(paths, binding)).rejects.toThrow("regular file");
  });

  test("symlinked storage and invalid scopes cannot create policy", async () => {
    const paths = await fixture();
    await fs.mkdir(path.dirname(paths.root), { recursive: true });
    const outside = path.join(roots.at(-1)!, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, paths.root);
    await expect(readTaskModelPolicy(paths, binding)).rejects.toThrow("directory is unsafe");
    await expect(setTaskModelPreference(paths, binding, { domain: "../ui", actions: ["implement"], model, reason: "Astra" })).rejects.toThrow("Invalid task model preference");
  });
});
