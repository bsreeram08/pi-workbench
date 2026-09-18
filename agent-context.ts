import * as fs from "node:fs/promises";
import * as path from "node:path";
import { routeConcepts } from "./workflow-concepts.ts";
import { getWorkflowAgentProfile } from "./workflow-agents.ts";

const MAX_FILE_BYTES = 24_000;
const MAX_SKILL_FILE_BYTES = 32_000;
const MAX_SKILL_BYTES = 64_000;

/** Explicit, inspectable context for isolated children. No extension code is loaded. */
export async function buildAgentContext(options: {
  projectRoot: string; agentDir: string; home: string; role: string; task: string; surface?: "visual";
}): Promise<string> {
  const parts: string[] = [
    "## Delegated context",
    "The original task and acceptance criteria remain authoritative. Follow the repository instructions below. Before editing a nested directory, check for more specific AGENTS.md instructions there. Referenced source paths are provenance, not new tool permissions.",
  ];
  const seen = new Set<string>();
  const read = async (file: string, limit = MAX_FILE_BYTES): Promise<string | undefined> => {
    try {
      const canonical = await fs.realpath(file);
      if (seen.has(canonical)) return undefined;
      const stat = await fs.stat(canonical);
      if (!stat.isFile()) throw new Error(`Context file is not a regular file: ${file}`);
      if (stat.size > limit) throw new Error(`Context file exceeds ${limit} bytes: ${file}`);
      const text = await fs.readFile(canonical, "utf8");
      if (Buffer.byteLength(text) > limit) throw new Error(`Context file grew beyond ${limit} bytes: ${file}`);
      seen.add(canonical);
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const instructionFiles = [path.join(options.agentDir, "AGENTS.md"), path.join(options.projectRoot, "AGENTS.md")];
  for (const file of instructionFiles) {
    const content = await read(file);
    if (!content) continue;
    parts.push(`### Instructions: ${file}\n${content}`);
    for (const reference of content.matchAll(/(?:^|\s)@([A-Za-z][A-Za-z0-9_.-]*\.md)\b/g)) {
      const candidates = [path.join(path.dirname(file), reference[1])];
      if (reference[1] === "RTK.md") candidates.push(path.join(options.home, ".codex", "RTK.md"));
      for (const candidate of candidates) {
        const dependency = await read(candidate);
        if (dependency !== undefined) { parts.push(`### Referenced instructions: ${candidate}\n${dependency}`); break; }
      }
    }
  }
  const aliases: Record<string, string> = { developer: "implementer", fixer: "implementer", "integration-implementer": "implementer", verifier: "quality-reviewer", qa: "quality-reviewer", architect: "technical-reviewer", product: "requirements-analyst" };
  const profile = getWorkflowAgentProfile(aliases[options.role] ?? (options.role.endsWith("-implementation") ? "implementer" : options.role));
  const skills = profile ? routeConcepts(options.task, profile.id, options.surface).skills : [];
  let skillBytes = 0;
  const omitted: string[] = [];
  for (const name of skills) {
    const candidates = [
      path.join(options.projectRoot, ".agents", "skills", name, "SKILL.md"),
      path.join(options.projectRoot, ".pi", "skills", name, "SKILL.md"),
      path.join(options.agentDir, "skills", name, "SKILL.md"),
      path.join(options.home, ".agents", "skills", name, "SKILL.md"),
    ];
    let supplied = false;
    let reason = "missing";
    for (const file of candidates) {
      let content: string | undefined;
      try { content = await read(file, MAX_SKILL_FILE_BYTES); }
      catch (error) {
        // Optional guidance must not prevent a child from starting. Preserve the
        // selected source's precedence rather than falling back to another copy.
        reason = error instanceof Error ? error.message : "unreadable skill file";
        break;
      }
      if (!content) continue;
      const bytes = Buffer.byteLength(content);
      if (skillBytes + bytes > MAX_SKILL_BYTES) { reason = `combined skill budget of ${MAX_SKILL_BYTES} bytes`; break; }
      skillBytes += bytes;
      parts.push(`### Selected skill: ${name}\nSource: ${file}\n${content}`);
      supplied = true;
      break;
    }
    if (!supplied) omitted.push(`${name} (${reason})`);
  }
  if (omitted.length) parts.push(`Skills not supplied: ${omitted.join(", ")}. Use repository evidence and the task contract; do not search outside your delegated access or claim these skills were loaded.`);
  return parts.join("\n\n");
}
