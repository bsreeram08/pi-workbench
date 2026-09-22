import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROK_47_CATALOG_MODEL, mergeGrok47Model } from "../grok-catalog.ts";

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-workbench-grok-catalog-"));
}

describe("grok-4.7 models.json merge", () => {
  test("creates models.json without an API key and keeps the model endpoint on the model", () => {
    const root = agentDir();
    const modelsPath = join(root, "models.json");
    try {
      expect(mergeGrok47Model(modelsPath)).toEqual({ status: "added" });
      const written = JSON.parse(readFileSync(modelsPath, "utf8"));
      expect(written.providers.xai.apiKey).toBeUndefined();
      expect(written.providers.xai.baseUrl).toBeUndefined();
      expect(written.providers.xai.models).toEqual([GROK_47_CATALOG_MODEL]);
      expect(mergeGrok47Model(modelsPath)).toEqual({ status: "present" });
      expect(readFileSync(modelsPath, "utf8")).toBe(`${JSON.stringify(written, null, 2)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appends grok-4.7 and preserves other providers, proxy settings, and existing xAI models", () => {
    const root = agentDir();
    const modelsPath = join(root, "models.json");
    const original = {
      providers: {
        openrouter: { baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "keep-me", name: "Keep" }] },
        xai: {
          baseUrl: "https://proxy.example/v1",
          apiKey: "$XAI_API_KEY",
          models: [{ id: "grok-4.6", name: "Grok 4.6 custom" }],
        },
      },
    };
    writeFileSync(modelsPath, `${JSON.stringify(original)}\n`);
    try {
      expect(mergeGrok47Model(modelsPath)).toEqual({ status: "added" });
      const written = JSON.parse(readFileSync(modelsPath, "utf8"));
      expect(written.providers.openrouter).toEqual(original.providers.openrouter);
      expect(written.providers.xai.baseUrl).toBe("https://proxy.example/v1");
      expect(written.providers.xai.apiKey).toBe("$XAI_API_KEY");
      expect(written.providers.xai.models[0]).toEqual(original.providers.xai.models[0]);
      expect(written.providers.xai.models[1]).toEqual(GROK_47_CATALOG_MODEL);
      expect(written.providers.xai.models[1].apiKey).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not replace a custom grok-4.7 entry or rewrite invalid or linked files", () => {
    const root = agentDir();
    const modelsPath = join(root, "models.json");
    const custom = {
      providers: { xai: { models: [{ id: "grok-4.7", name: "Mine", baseUrl: "https://proxy.example/v1" }] } },
    };
    writeFileSync(modelsPath, `${JSON.stringify(custom, null, 2)}\n`);
    const before = readFileSync(modelsPath, "utf8");
    const broken = join(root, "broken");
    mkdirSync(broken);
    const brokenPath = join(broken, "models.json");
    writeFileSync(brokenPath, "{not json\n");
    const linked = join(root, "linked");
    mkdirSync(linked);
    const outside = join(root, "outside.json");
    writeFileSync(outside, "{\"providers\":{}}\n");
    symlinkSync(outside, join(linked, "models.json"));
    try {
      expect(mergeGrok47Model(modelsPath)).toEqual({ status: "present" });
      expect(readFileSync(modelsPath, "utf8")).toBe(before);
      expect(mergeGrok47Model(brokenPath).status).toBe("skipped");
      expect(readFileSync(brokenPath, "utf8")).toBe("{not json\n");
      expect(mergeGrok47Model(join(linked, "models.json")).status).toBe("skipped");
      expect(lstatSync(join(linked, "models.json")).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("{\"providers\":{}}\n");
      expect(mergeGrok47Model(join(root, "not-models.json")).status).toBe("skipped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Pi keeps built-in grok-4.6 when models.json adds grok-4.7", async () => {
    const root = agentDir();
    const modelsPath = join(root, "models.json");
    try {
      expect(mergeGrok47Model(modelsPath)).toEqual({ status: "added" });
      const { ModelConfig } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js");
      const { composeModelProvider } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js");
      const { xaiProvider } = await import("../node_modules/@earendil-works/pi-ai/dist/providers/xai.js");
      const config = await ModelConfig.load(modelsPath);
      expect(config.error).toBeUndefined();
      const provider = composeModelProvider("xai", xaiProvider(), config, undefined);
      const ids = provider.getModels().map((model: { id: string }) => model.id);
      expect(ids).toContain("grok-4.6");
      expect(ids).toContain("grok-4.7");
      const added = provider.getModels().find((model: { id: string }) => model.id === "grok-4.7");
      expect(added.baseUrl).toBe("https://api.x.ai/v1");
      expect(added.api).toBe("openai-responses");
      expect(added.cost.tiers[0].inputTokensAbove).toBe(200000);
      const kept = provider.getModels().find((model: { id: string }) => model.id === "grok-4.6");
      expect(kept.baseUrl).toBe("https://api.x.ai/v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
