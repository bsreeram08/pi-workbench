import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import type { WorkflowPaths } from "./workflow-state.ts";

export interface ReviewContinuity {
  version: 1;
  artifactDigest: string;
  observations: Array<{ id: string; text: string }>;
  repeated: string[];
  unchangedArtifact: boolean;
  nextDecision: string;
}

/** Text fingerprints help navigate recurring findings; they never establish truth or approval. */
export function summarizeReviewContinuity(artifactDigest: string, output: string, previous?: ReviewContinuity): ReviewContinuity {
  const texts = output.replace(/<(?:plan|code)-verdict>[\s\S]*?<\/(?:plan|code)-verdict>/g, "")
    .split(/\n\s*\n/).map(text => text.trim()).filter(text => text && !/^#{1,6}[^\n]*$/.test(text)).slice(0, 64);
  const observations = texts.map(text => {
    const normalized = text.replace(/^\s*(?:\d+[.)]|[-*])\s+/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
    return { id: `finding-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`, text: text.slice(0, 2000) };
  });
  const prior = new Set(previous?.observations.map(item => item.id) ?? []);
  const repeated = [...new Set(observations.filter(item => prior.has(item.id)).map(item => item.id))];
  const unchangedArtifact = previous?.artifactDigest === artifactDigest;
  return { version: 1, artifactDigest, observations, repeated, unchangedArtifact,
    nextDecision: unchangedArtifact && repeated.length
      ? "The artifact and review text repeat. Explain new evidence or choose a different corrective approach before delegating again. Text repetition is a signal, not proof of stagnation."
      : "Assess findings against current evidence. Preserve resolved decisions and admit newly evidenced material blockers." };
}

/** Advisory history only. Unsafe, malformed, or oversized artifacts are ignored, never made authoritative. */
export async function readReviewContinuity(paths: WorkflowPaths, planId: string, lane: "plan" | "execution"): Promise<ReviewContinuity | undefined> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(planId)) return undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    // Canonicalize the trusted root (macOS /var may itself alias /private/var),
    // then reject aliases introduced below the workflow artifact root.
    const directory = path.join(await fs.realpath(paths.root), "runs", planId);
    if (await fs.realpath(directory) !== path.resolve(directory)) return undefined;
    handle = await fs.open(path.join(directory, `${lane}-continuity.md`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 160_000) return undefined;
    const buffer = Buffer.alloc(160_001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 160_000) return undefined;
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!value || value.version !== 1 || typeof value.artifactDigest !== "string"
      || !Array.isArray(value.observations) || value.observations.length > 64
      || !value.observations.every((item: any) => item && /^finding-[a-f0-9]{16}$/.test(item.id) && typeof item.text === "string" && item.text.length <= 2000)) return undefined;
    // Recompute metadata; nothing else in the file is trusted or used as an instruction.
    return { version: 1, artifactDigest: value.artifactDigest, observations: value.observations,
      repeated: [], unchangedArtifact: false, nextDecision: "Advisory previous review text; independently verify all claims." };
  } catch { return undefined; }
  finally { await handle?.close().catch(() => {}); }
}
