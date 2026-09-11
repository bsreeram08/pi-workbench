import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./types.ts";

const VIEWER_HOST = "127.0.0.1";
const VIEWER_PORT = 47821;
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "qmd-viewer.html");

export interface QmdCollectionCard {
  name: string;
  uri: string;
  pattern: string;
  files: number;
  updated: string;
  empty: boolean;
  workbench: boolean;
}

export interface QmdFileCard {
  uri: string;
  path: string;
  size: string;
  updated: string;
}

export function parseQmdCollectionList(text: string): QmdCollectionCard[] {
  const cards: QmdCollectionCard[] = [];
  const blocks = text.split(/\n(?=\s{0,2}[A-Za-z0-9._-]+ \(qmd:\/\/)/);
  for (const block of blocks) {
    const header = block.match(/^\s*([A-Za-z0-9._-]+) \(qmd:\/\/([^/)\s]*)\/?\)/);
    if (!header) continue;
    const filesMatch = block.match(/Files:\s+(\d+)/i);
    const pattern = block.match(/Pattern:\s+(\S+)/i)?.[1] ?? "**/*.md";
    const updated = block.match(/updated\s+([^)]+)\)/i)?.[1]?.trim()
      ?? block.match(/Updated:\s+(.+)$/im)?.[1]?.trim()
      ?? "";
    const files = filesMatch ? Number(filesMatch[1]) : 0;
    const name = header[1];
    cards.push({
      name,
      uri: `qmd://${name}/`,
      pattern,
      files,
      updated,
      empty: files === 0 || /never/i.test(updated),
      workbench: name.startsWith("pi-workbench-"),
    });
  }
  return cards;
}

export function parseQmdLs(text: string): QmdFileCard[] {
  const files: QmdFileCard[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\S+(?:\s+\S+)?)\s+(\w{3}\s+\d{1,2}\s+\d{2}:\d{2})\s+(qmd:\/\/\S+)\s*$/);
    if (!match) continue;
    const uri = match[3].replace(/\/$/, "");
    const pathPart = uri.replace(/^qmd:\/\/[^/]+\//, "");
    files.push({ uri, path: pathPart, size: match[1], updated: match[2] });
  }
  return files;
}

function safeCollection(value: string | null): string | undefined {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) return undefined;
  return value;
}

function safeDocId(value: string | null): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("qmd://")) return undefined;
  if (value.includes("..") || value.includes("\0") || /\s/.test(value)) return undefined;
  if (value.length > 1024) return undefined;
  return value;
}

async function runQmd(exec: Exec, args: string[]): Promise<string> {
  const result = await exec("qmd", args, { timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr?.trim() || "qmd failed");
  return result.stdout;
}

export async function qmdViewerPayload(
  pathname: string,
  query: URLSearchParams,
  exec: Exec,
): Promise<{ status: number; body: unknown } | { status: number; html: string } | { status: number; text: string }> {
  if (pathname === "/" || pathname === "/index.html") {
    const html = await fs.readFile(PAGE, "utf8");
    return { status: 200, html };
  }
  if (pathname === "/api/collections") {
    const text = await runQmd(exec, ["collection", "list"]);
    return { status: 200, body: { collections: parseQmdCollectionList(text) } };
  }
  if (pathname === "/api/files") {
    const collection = safeCollection(query.get("collection"));
    if (!collection) return { status: 400, body: { error: "Invalid collection." } };
    const text = await runQmd(exec, ["ls", collection]);
    return { status: 200, body: { collection, files: parseQmdLs(text) } };
  }
  if (pathname === "/api/doc") {
    const id = safeDocId(query.get("id"));
    if (!id) return { status: 400, body: { error: "Invalid document id." } };
    const text = await runQmd(exec, ["get", id]);
    return { status: 200, body: { id, text } };
  }
  if (pathname === "/api/search") {
    const q = query.get("q")?.trim() ?? "";
    if (!q || q.length > 400) return { status: 400, body: { error: "Invalid query." } };
    const args = ["search", q, "-n", "30"];
    const collection = safeCollection(query.get("collection"));
    if (collection) args.push("-c", collection);
    const text = await runQmd(exec, args);
    return { status: 200, body: { query: q, text } };
  }
  return { status: 404, body: { error: "Not found." } };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === ":ffff:127.0.0.1";
}

export function attachQmdViewer(server: Server, exec: Exec): void {
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403).end("loopback only");
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://${VIEWER_HOST}`);
      try {
        const payload = await qmdViewerPayload(url.pathname, url.searchParams, exec);
        if ("html" in payload) {
          res.writeHead(payload.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(payload.html);
          return;
        }
        if ("text" in payload) {
          res.writeHead(payload.status, { "content-type": "text/plain; charset=utf-8" });
          res.end(payload.text);
          return;
        }
        res.writeHead(payload.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(payload.body));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "qmd failed" }));
      }
    })();
  });
}

export function registerQmdViewer(pi: ExtensionAPI, exec: Exec): void {
  let server: Server | undefined;
  const listen = async (): Promise<string> => {
    if (server?.listening) return `http://${VIEWER_HOST}:${VIEWER_PORT}/`;
    server = createServer();
    attachQmdViewer(server, exec);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(VIEWER_PORT, VIEWER_HOST, resolve);
    });
    return `http://${VIEWER_HOST}:${VIEWER_PORT}/`;
  };
  pi.registerCommand("qmd", {
    description: "Open a localhost QMD browser (collections, files, search, markdown preview)",
    handler: async (_args, ctx) => {
      try {
        const url = await listen();
        await exec("open", [url], { timeout: 5_000 }).catch(() => undefined);
        ctx.ui.notify(`QMD viewer: ${url}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Could not start QMD viewer.", "error");
      }
    },
  });
  pi.on("session_shutdown", () => {
    server?.close();
    server = undefined;
  });
}
