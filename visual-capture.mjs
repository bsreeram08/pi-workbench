#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import fs from "node:fs";
import path from "node:path";

const [rawUrl, widthArg, heightArg, outputPath] = process.argv.slice(2);
if (!rawUrl || !widthArg || !heightArg || !outputPath) throw new Error("Usage: visual-capture.mjs <url> <width> <height> <outputPath>");
const url = new URL(rawUrl);
if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http/https URLs are supported");
const host = url.hostname.toLowerCase();
const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || (isIP(host) && (host === "127.0.0.1" || host === "::1"));
if (!loopback) throw new Error("Only loopback URLs are allowed");
const width = Number(widthArg);
const height = Number(heightArg);
if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error("Invalid viewport");

function loadPlaywright() {
  const candidates = [];
  if (process.env.NODE_PATH) candidates.push(...process.env.NODE_PATH.split(path.delimiter));
  try { candidates.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim()); } catch {}
  for (const root of candidates.filter(Boolean)) {
    try { return createRequire(path.join(root, "pi-workbench-visual-loader.cjs"))("playwright"); } catch {}
  }
  try { return createRequire(import.meta.url)("playwright"); } catch {}
  throw new Error("Playwright is not installed. Install it globally to capture visual plans.");
}

const { chromium } = loadPlaywright();
const executableCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : process.platform === "win32"
    ? []
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = executableCandidates.find((candidate) => {
  try { return fs.existsSync(candidate); } catch { return false; }
});

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultNavigationTimeout(20_000);
  await page.goto(url.toString(), { waitUntil: "load" });
  const final = new URL(page.url());
  const finalHost = final.hostname.toLowerCase();
  const stillLoopback = finalHost === "localhost" || finalHost === "127.0.0.1" || finalHost === "::1";
  if (!stillLoopback) throw new Error("Capture redirected off loopback.");
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
