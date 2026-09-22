import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Pi upserts `models.json` models by id and keeps built-in xAI models.
 * `registerProvider({ models })` replaces that provider's catalog, so this
 * merge is the only safe way to add Grok 4.7 beside Grok 4.6.
 * Published 2026-09-21 rates: $2 / $0.50 / $6 per 1M below 200k prompt tokens,
 * and $4 / $1 / $12 above. No API key is stored; `/login` remains the credential.
 */
export const GROK_47_CATALOG_MODEL = {
  id: "grok-4.7",
  name: "Grok 4.7",
  api: "openai-responses",
  baseUrl: "https://api.x.ai/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
    tiers: [
      {
        inputTokensAbove: 200000,
        input: 4,
        output: 12,
        cacheRead: 1,
        cacheWrite: 0,
      },
    ],
  },
  contextWindow: 500000,
  maxTokens: 500000,
  compat: { supportsLongCacheRetention: false },
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: null,
  },
} as const;

export type GrokCatalogMerge =
  | { status: "added" }
  | { status: "present" }
  | { status: "skipped"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function skip(reason: string): GrokCatalogMerge {
  return { status: "skipped", reason };
}

/** Insert grok-4.7 into a models.json file. Leaves every other provider and model alone. */
export function mergeGrok47Model(modelsPath: string): GrokCatalogMerge {
  const resolved = path.resolve(modelsPath);
  if (path.basename(resolved) !== "models.json") return skip("Workbench only edits a models.json file.");
  const parent = path.dirname(resolved);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    return skip("Pi's agent directory is missing, so Workbench did not create models.json.");
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return skip("Pi's agent directory is not a real directory, so Workbench left models.json unchanged.");
  }

  let existing: string | undefined;
  let mode = 0o600;
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return skip("models.json is not a regular file, so Workbench left it unchanged.");
    }
    mode = stat.mode & 0o777;
    existing = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return skip("Workbench could not read models.json, so it left that file unchanged.");
  }

  let parsed: Record<string, unknown>;
  if (existing === undefined) {
    parsed = { providers: {} };
  } else {
    const source = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing;
    try {
      const value = JSON.parse(source) as unknown;
      if (!isRecord(value)) return skip("models.json is not a JSON object, so Workbench left it unchanged.");
      parsed = value;
    } catch {
      return skip("models.json is not valid JSON, so Workbench left it unchanged.");
    }
  }

  if (parsed.providers === undefined) parsed.providers = {};
  if (!isRecord(parsed.providers)) return skip("models.json providers is not an object, so Workbench left it unchanged.");
  const providers = parsed.providers;
  if (providers.xai === undefined) providers.xai = {};
  if (!isRecord(providers.xai)) return skip("models.json xai provider is not an object, so Workbench left it unchanged.");
  const xai = providers.xai;
  if (xai.models === undefined) xai.models = [];
  if (!Array.isArray(xai.models)) return skip("models.json xai models is not an array, so Workbench left it unchanged.");
  if (xai.models.some((model) => isRecord(model) && model.id === GROK_47_CATALOG_MODEL.id)) {
    return { status: "present" };
  }
  xai.models.push(JSON.parse(JSON.stringify(GROK_47_CATALOG_MODEL)) as unknown);

  const temporary = path.join(parent, `.models.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode });
    fs.renameSync(temporary, resolved);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The original models.json is still in place.
    }
    return skip("Workbench could not write models.json, so the previous file is unchanged.");
  }
  return { status: "added" };
}
