import * as fs from "node:fs/promises";
import * as path from "node:path";

export type SkillScanSeverity = "critical" | "high";

export interface SkillScanFinding {
  readonly severity: SkillScanSeverity;
  readonly id: string;
  readonly relativePath: string;
  readonly detail: string;
}

const MAX_FILE_BYTES = 512 * 1024;
const SCANNED_EXTENSIONS = new Set([".md", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".py", ".json", ".html", ".txt"]);

const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp; detail: string }> = [
  { id: "private-key", pattern: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, detail: "embedded private key material" },
  { id: "github-token", pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/, detail: "GitHub token" },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/, detail: "npm token" },
  { id: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/, detail: "AWS access key" },
  { id: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/, detail: "Google API key" },
  { id: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, detail: "sk- credential" },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, detail: "Slack token" },
];

const INJECTION_PATTERNS: Array<{ id: string; pattern: RegExp; detail: string; severity: SkillScanSeverity }> = [
  { id: "ignore-instructions", pattern: /\b(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|system|developer)\s+instructions\b/i, detail: "prompt-injection instruction override", severity: "critical" },
  { id: "role-hijack", pattern: /(?:^|\n)\s*(?:SYSTEM|DEVELOPER)\s*:\s*\S/i, detail: "fake system/developer role header", severity: "critical" },
  { id: "hidden-markup-role", pattern: /<\/?(?:system|developer)(?:\s[^>]*)?>/i, detail: "hidden system/developer markup", severity: "critical" },
  { id: "remote-shell", pattern: /\b(?:curl|wget|fetch)\b[\s\S]{0,200}\|\s*(?:ba)?sh\b/i, detail: "download piped to a shell", severity: "critical" },
  { id: "eval-base64", pattern: /\b(?:eval|exec)\s*\(\s*(?:atob|Buffer\.from)\b/, detail: "eval of decoded payload", severity: "critical" },
  { id: "skip-permissions", pattern: /--dangerously-skip-permissions/, detail: "permission bypass flag", severity: "high" },
  { id: "auto-approve-mcp", pattern: /\benableAllProjectMcpServers\b/, detail: "auto-approve project MCP servers", severity: "high" },
];

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/;

function finding(severity: SkillScanSeverity, id: string, relativePath: string, detail: string): SkillScanFinding {
  return { severity, id, relativePath, detail };
}

function scanText(relativePath: string, text: string): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  if (ZERO_WIDTH.test(text)) {
    findings.push(finding("critical", "hidden-unicode", relativePath, "zero-width or bidi control characters"));
  }
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) findings.push(finding("critical", rule.id, relativePath, rule.detail));
  }
  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(text)) findings.push(finding(rule.severity, rule.id, relativePath, rule.detail));
  }
  return findings;
}

async function visit(root: string, current: string, findings: SkillScanFinding[]): Promise<void> {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Skill contains a symbolic link: ${candidate}`);
    if (stat.isDirectory()) {
      await visit(root, candidate, findings);
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SCANNED_EXTENSIONS.has(extension) && entry.name !== "SKILL.md") continue;
    if (stat.size > MAX_FILE_BYTES) {
      findings.push(finding("high", "oversized-file", path.relative(root, candidate), `file exceeds ${MAX_FILE_BYTES} bytes`));
      continue;
    }
    const text = await fs.readFile(candidate, "utf8");
    findings.push(...scanText(path.relative(root, candidate) || entry.name, text));
  }
}

export async function scanSkillTree(sourceDir: string): Promise<SkillScanFinding[]> {
  const findings: SkillScanFinding[] = [];
  await visit(sourceDir, sourceDir, findings);
  return findings;
}

export function formatSkillScanFailure(name: string, findings: readonly SkillScanFinding[]): string {
  const details = findings.map((item) => `${item.severity} ${item.id} (${item.relativePath}): ${item.detail}`).join("; ");
  return `Staged skill ${name} failed supply-chain scan: ${details}`;
}
