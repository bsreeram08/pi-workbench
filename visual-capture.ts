import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isIP } from "node:net";

const exec = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "visual-capture.mjs");

export function assertLoopbackCaptureUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("captureUrl must be a valid http(s) URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("captureUrl must be http or https.");
  if (url.username || url.password) throw new Error("captureUrl must not include credentials.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return url;
  if (isIP(host) && (host === "127.0.0.1" || host === "::1")) return url;
  throw new Error("captureUrl must be a loopback address (127.0.0.1, localhost, or ::1).");
}

export async function captureLoopbackPng(input: {
  url: string;
  viewport: { width: number; height: number };
  outputPath: string;
}): Promise<{ bytes: Buffer }> {
  const url = assertLoopbackCaptureUrl(input.url);
  if (![input.viewport.width, input.viewport.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) {
    throw new Error("Invalid capture viewport.");
  }
  try {
    await exec("node", [SCRIPT, url.toString(), String(input.viewport.width), String(input.viewport.height), input.outputPath], {
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Host visual capture failed: ${message}`);
  }
  const bytes = await fs.readFile(input.outputPath);
  if (bytes.length < 45) throw new Error("Host visual capture produced no PNG.");
  return { bytes };
}
