import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildAgentContext } from "../agent-context.ts";
import { routeConcepts } from "../workflow-concepts.ts";
import { routeTask } from "../routing.ts";
import { buildCodeReviewTask } from "../workflow-prompts.ts";

describe("task-specific child context", () => {
  test("planning interviews are opt-in rather than a default skill", () => {
    for (const role of ["planner", "requirements-analyst", "execution-manager"] as const) {
      expect(routeConcepts("Build a 3D resume from resume-data.json", role).skills).not.toContain("grilling");
      expect(routeConcepts("Interview me about the requirements", role).skills).toContain("grilling");
    }
  });
  test("loads a full design skill larger than the instruction limit alongside implementation guidance", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-large-"));
    try {
      const skillRoot = path.join(base, "agent", "skills");
      for (const [name, size] of [["emil-design-eng", 27_226], ["codebase-design", 6_446], ["tdd", 3_549], ["animate", 11_575]] as const) {
        await fs.mkdir(path.join(skillRoot, name), { recursive: true });
        await fs.writeFile(path.join(skillRoot, name, "SKILL.md"), "x".repeat(size - name.length) + name);
      }
      const bundle = await buildAgentContext({ projectRoot: base, agentDir: path.join(base, "agent"), home: base, role: "implementer", task: "Build a 3D UI with animation" });
      for (const name of ["emil-design-eng", "codebase-design", "tdd", "animate"]) expect(bundle).toContain(`Selected skill: ${name}`);
      expect(bundle).toContain("x".repeat(27_226 - "emil-design-eng".length) + "emil-design-eng");
      expect(bundle).not.toContain("Skills not supplied");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  test("omits oversized or non-file optional skills without falling back to lower-priority copies", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-optional-"));
    try {
      const local = path.join(base, ".agents", "skills", "emil-design-eng", "SKILL.md");
      const fallback = path.join(base, "agent", "skills", "emil-design-eng", "SKILL.md");
      await fs.mkdir(path.dirname(local), { recursive: true });
      await fs.mkdir(path.dirname(fallback), { recursive: true });
      await fs.writeFile(local, "x".repeat(32_001));
      await fs.writeFile(fallback, "LOWER-PRIORITY-COPY");
      const options = { projectRoot: base, agentDir: path.join(base, "agent"), home: base, role: "codebase-explorer", task: "Inspect the UI" };
      const oversized = await buildAgentContext(options);
      expect(oversized).toContain("exceeds 32000 bytes");
      expect(oversized).not.toContain("LOWER-PRIORITY-COPY");
      await fs.rm(local);
      await fs.mkdir(local);
      expect(await buildAgentContext(options)).toContain("not a regular file");
      await fs.writeFile(path.join(base, "AGENTS.md"), "x".repeat(24_001));
      await expect(buildAgentContext(options)).rejects.toThrow("exceeds 24000 bytes");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  test("enforces the aggregate skill budget without truncating or aborting", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-budget-"));
    try {
      for (const name of ["tdd", "codebase-design", "emil-design-eng"]) {
        const file = path.join(base, "agent", "skills", name, "SKILL.md");
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "x".repeat(30_000));
      }
      const bundle = await buildAgentContext({ projectRoot: base, agentDir: path.join(base, "agent"), home: base, role: "implementer", task: "Build UI" });
      expect(bundle).toContain("Selected skill: tdd");
      expect(bundle).toContain("Selected skill: codebase-design");
      expect(bundle).not.toContain("Selected skill: emil-design-eng");
      expect(bundle).toContain("combined skill budget of 64000 bytes");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  test("supplies project instructions, referenced RTK and selected skill content", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-"));
    try {
      const projectRoot = path.join(base, "project");
      const agentDir = path.join(base, "agent");
      const home = path.join(base, "home");
      await fs.mkdir(projectRoot);
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      await fs.mkdir(path.join(home, ".agents", "skills", "tdd"), { recursive: true });
      await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "@RTK.md\nPreserve the domain language.");
      await fs.writeFile(path.join(home, ".codex", "RTK.md"), "Prefix shell commands with rtk.");
      await fs.writeFile(path.join(home, ".agents", "skills", "tdd", "SKILL.md"), "Write a failing behavioral test first.");
      const bundle = await buildAgentContext({ projectRoot, agentDir, home, role: "implementer", task: "Fix build" });
      expect(bundle).toContain("Preserve the domain language");
      expect(bundle).toContain("Prefix shell commands with rtk");
      expect(bundle).toContain("Write a failing behavioral test first");
      expect(bundle).toContain("Skills not supplied");
      expect(bundle).not.toContain("emil-design-eng");
      const integration = await buildAgentContext({ projectRoot, agentDir, home, role: "integration-implementer", task: "Fix build" });
      expect(integration).toContain("Write a failing behavioral test first");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  test("does not route ordinary words as UI work or long text as hard work", () => {
    expect(routeConcepts("Fix the build requirements", "implementer").packs).not.toContain("design");
    expect(routeConcepts("Improve UI animation", "implementer").packs).toContain("design");
    expect(routeConcepts("Rebuild the billing page", "implementer").packs).not.toContain("design");
    expect(routeConcepts("Rebuild the billing page", "implementer", "visual").skills).toContain("emil-design-eng");
    expect(routeConcepts("Rebuild the billing page", "implementer", "visual").skills).toContain("animate");
    const request = { task: "Find README", role: "codebase-explorer", readOnly: true };
    expect(routeTask({ ...request, task: `${request.task}\n${"x".repeat(2000)}` }).effort).toBe(routeTask(request).effort);
  });

  test("independent review does not receive the implementer's self-assessment", () => {
    const prompt = buildCodeReviewTask("quality-reviewer", "task", "plan", "AUTHOR-CERTAINTY-SENTINEL");
    expect(prompt).not.toContain("AUTHOR-CERTAINTY-SENTINEL");
    expect(prompt).toContain("Form your own assessment");
    expect(prompt).not.toContain("A passing build is not visual completion");
    expect(buildCodeReviewTask("quality-reviewer", "task", "plan", "", undefined, undefined, "visual")).toContain("A passing build is not visual completion");
  });
});
