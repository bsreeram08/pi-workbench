import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { inflateSync } from "node:zlib";
import { workspaceSnapshot } from "./verification.ts";
import { captureLoopbackPng } from "./visual-capture.ts";

const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const ignored = (name: string) => name === ".git" || name.startsWith(".git/") || name === ".pi/pi-workbench" || name.startsWith(".pi/pi-workbench/");
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export type InventoryResult = { status: "available"; root: string; snapshot: string; files: Record<string, string> }
  | { status: "unavailable"; error: string };

/** Observes content relative to the dirty starting state, even if a child commits.
 * This is a change inventory, never proof of process authorship. */
export async function captureSupervisionInventory(root: string): Promise<InventoryResult> {
  try {
    root = await fs.realpath(root);
    const snapshot = await workspaceSnapshot(root); // Broken Git metadata fails here, not silently to filesystem mode.
    let names: string[];
    try {
      const result = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      names = [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
    } catch (error) {
      if (!/not a git repository/.test(String((error as { stderr?: string }).stderr))) throw error;
      names = [];
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 64 || names.length > 20_000) throw new Error("Inventory traversal limit exceeded.");
        for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
          const relative = path.join(directory, entry.name);
          if (ignored(relative)) continue;
          if (entry.isDirectory()) await walk(relative, depth + 1);
          else names.push(relative);
        }
      };
      await walk("", 0);
      names.sort();
    }
    if (names.length > 20_000) throw new Error("Inventory file limit exceeded.");
    const files: Record<string, string> = Object.create(null);
    let bytes = 0;
    for (const name of names) {
      if (ignored(name)) continue;
      const file = path.resolve(root, name);
      if (!within(root, file)) throw new Error("Inventory path escaped the project.");
      const stat = await fs.lstat(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) files[name] = hash(`link\0${await fs.readlink(file)}`);
      else if (stat.isDirectory()) files[name] = `submodule:${await workspaceSnapshot(file, 1)}`;
      else if (stat.isFile()) {
        bytes += stat.size;
        if (stat.size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error("Inventory content limit exceeded.");
        if (!within(root, await fs.realpath(file))) throw new Error("Inventory file resolves outside the project.");
        files[name] = hash(`${stat.mode & 0o777}\0${hash(await fs.readFile(file))}`);
      } else throw new Error("Inventory requires ordinary files or symlinks.");
    }
    if (snapshot !== await workspaceSnapshot(root)) throw new Error("Workspace changed during inventory collection.");
    return { status: "available", root, snapshot, files };
  } catch (error) {
    return { status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

export function compareSupervisionInventories(before: InventoryResult, after: InventoryResult) {
  if (before.status !== "available" || after.status !== "available") return {
    status: "unavailable" as const, error: [before, after].filter((item) => item.status === "unavailable").map((item) => item.error).join("; "),
  };
  if (before.root !== after.root) return { status: "unavailable" as const, error: "Inventory project roots differ." };
  const changes = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
    .filter((name) => before.files[name] !== after.files[name])
    .map((name) => ({ path: name, kind: !(name in before.files) ? "added" as const : !(name in after.files) ? "deleted" as const : "modified" as const }));
  return { status: "available" as const, snapshotBefore: before.snapshot, snapshotAfter: after.snapshot, changes, authorship: "unattributed" as const };
}

export interface InspectionReceipt {
  version: 1; kind: "source"; id: string; root: string; sessionId: string; planId: string; snapshot: string; createdAt: string;
  contentCategory?: "deletion-inventory" | "empty-inventory";
  files: Array<{ path: string; digest: string; bytesReturned: number; truncated: boolean; startLine?: number }>;
}

export interface VisualReceipt {
  version: 1; kind: "visual"; id: string; root: string; sessionId: string; planId: string; snapshot: string; createdAt: string;
  artifactPath: string; digest: string; width: number; height: number;
  reported: { route: string; viewport: { width: number; height: number }; observations: string };
  provenance: "caller-supplied-image" | "host-captured-image";
}

export type VisualCaptureFn = (input: { url: string; viewport: { width: number; height: number }; outputPath: string }) => Promise<{ bytes: Buffer }>;
export type SupervisionReceipt = InspectionReceipt | VisualReceipt;

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Visual evidence requires a valid PNG.");
  let offset = 8, width = 0, height = 0, channels = 0, ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("Truncated PNG chunk.");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (const byte of buffer.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== buffer.readUInt32BE(end - 4)) throw new Error("PNG checksum failed.");
    if (offset === 8 && type !== "IHDR") throw new Error("PNG header missing.");
    if (type === "IHDR") {
      if (offset !== 8 || length !== 13) throw new Error("Invalid PNG header.");
      width = buffer.readUInt32BE(offset + 8); height = buffer.readUInt32BE(offset + 12);
      const depth = buffer[offset + 16], color = buffer[offset + 17];
      channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000 || depth !== 8 || !channels || buffer[offset + 18] || buffer[offset + 19] || buffer[offset + 20]) throw new Error("Use an 8-bit non-interlaced PNG up to 16 megapixels.");
    } else if (type === "IDAT") compressed.push(buffer.subarray(offset + 8, end - 4));
    else if (type === "IEND") {
      if (length || end !== buffer.length) throw new Error("Invalid PNG ending.");
      ended = true; break;
    } else if (type[0] === type[0]?.toUpperCase() && type !== "PLTE") throw new Error("Unsupported PNG critical chunk.");
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error("PNG image data missing.");
  const stride = width * channels + 1;
  const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height });
  if (decoded.length !== stride * height) throw new Error("PNG image size mismatch.");
  for (let row = 0; row < height; row++) if (decoded[row * stride] > 4) throw new Error("Invalid PNG row filter.");
  return { width, height };
}

/** Native IDs attest only to content returned by this host to a parent session.
 * They do not attest to comprehension or visual/behavioral quality. */
export class InspectionEvidenceStore {
  private receipts = new Map<string, SupervisionReceipt>();
  constructor(private readonly capture: VisualCaptureFn = captureLoopbackPng) {}
  clear(): void { this.receipts.clear(); }

  /** Only host-retained baselines may be passed here; never accept this argument
   * from a model tool parameter. Metadata cannot replace reading new source. */
  async inspectChanges(input: { root: string; sessionId: string; planId: string; before?: InventoryResult }) {
    if (!input.sessionId || !input.planId) throw new Error("Inventory inspection requires parent session and plan.");
    const after = await captureSupervisionInventory(input.root);
    if (after.status !== "available") throw new Error(`Inventory inspection unavailable: ${after.error}`);
    const empty = Object.keys(after.files).length === 0;
    let changes: Array<{ path: string; kind: "added" | "modified" | "deleted" }> = [];
    if (input.before?.status === "available") {
      const comparison = compareSupervisionInventories(input.before, after);
      if (comparison.status !== "available") throw new Error(comparison.error);
      changes = comparison.changes;
      if (changes.some((change) => change.kind !== "deleted")) throw new Error("Added or modified source requires source inspection, not an inventory receipt.");
      if (!changes.length && !empty) throw new Error("No deletion-only changes; inspect actual source files.");
    } else if (!empty) throw new Error("Deletion inspection requires a host baseline; inspect actual source files.");
    const category = changes.length ? "deletion-inventory" as const : "empty-inventory" as const;
    const content = JSON.stringify({ category, snapshot: after.snapshot, snapshotBefore: input.before?.status === "available" ? input.before.snapshot : null,
      deleted: changes.map((change) => ({ path: change.path, priorDigest: input.before?.status === "available" ? input.before.files[change.path] : undefined })),
      currentFileCount: Object.keys(after.files).length,
      limitation: "Host-observed path and digest metadata only; deleted source content was not returned. This does not prove authorship or correctness." }, null, 2);
    if (Buffer.byteLength(content) > 65_536) throw new Error("Deletion inventory exceeds inspection output limit.");
    const file = { path: `(${category})`, content, digest: hash(content), bytesReturned: Buffer.byteLength(content), truncated: false };
    const receipt: InspectionReceipt = { version: 1, kind: "source", contentCategory: category, id: randomUUID(), root: after.root, sessionId: input.sessionId,
      planId: input.planId, snapshot: after.snapshot, createdAt: new Date().toISOString(), files: [{ path: file.path, digest: file.digest, bytesReturned: file.bytesReturned, truncated: false }] };
    if (this.receipts.size >= 1000) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(receipt.id, structuredClone(receipt));
    return { receipt, files: [file] };
  }

  async inspect(input: { root: string; sessionId: string; planId: string; paths: string[]; maxBytes?: number; startLine?: number }) {
    if (!input.sessionId || !input.planId || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 20) throw new Error("Inspection needs parent session, plan, and 1–20 paths.");
    const limit = input.maxBytes ?? 32_768;
    if (!Number.isInteger(limit) || limit < 1 || limit > 65_536) throw new Error("Inspection output limit must be 1–65536 bytes.");
    const startLine = input.startLine ?? 1;
    if (!Number.isInteger(startLine) || startLine < 1 || startLine > 10_000_000) throw new Error("Inspection startLine must be a positive bounded integer.");
    const root = await fs.realpath(input.root);
    const snapshot = await workspaceSnapshot(root);
    let remaining = limit;
    const files: Array<{ path: string; content: string; digest: string; bytesReturned: number; truncated: boolean; startLine: number }> = [];
    for (const name of [...new Set(input.paths)]) {
      const file = path.resolve(root, name);
      const relative = path.relative(root, file);
      if (!within(root, file) || !relative || ignored(relative) || !within(root, await fs.realpath(file))) throw new Error("Inspection path must stay in project source.");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Inspection requires a bounded regular file.");
      if (remaining === 0) throw new Error("Inspection output budget exhausted; request fewer paths.");
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let buffer: Buffer;
      let offset = 0;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error("Source changed before inspection.");
        const target = Buffer.alloc(stat.size);
        let size = 0;
        while (size < target.length) {
          const read = await handle.read(target, size, target.length - size, size);
          if (!read.bytesRead) throw new Error("Source changed during inspection.");
          size += read.bytesRead;
        }
        for (let line = 1; line < startLine; line++) {
          const newline = target.indexOf(10, offset);
          if (newline < 0) throw new Error("Inspection startLine is outside the source file.");
          offset = newline + 1;
        }
        if (offset >= target.length && startLine > 1) throw new Error("Inspection startLine is outside the source file.");
        buffer = target.subarray(offset, offset + remaining);
      } finally { await handle.close(); }
      if (buffer.includes(0)) throw new Error("Source inspection does not accept binary files.");
      // Drop an incomplete trailing UTF-8 sequence; never exceed the returned byte budget.
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer, { stream: true });
      const bytesReturned = Buffer.byteLength(content);
      remaining -= bytesReturned;
      files.push({ path: relative, content, digest: hash(content), bytesReturned, startLine, truncated: offset > 0 || bytesReturned < stat.size });
    }
    if (snapshot !== await workspaceSnapshot(root)) throw new Error("Workspace changed during inspection; inspect again.");
    if (!files.some((file) => file.bytesReturned > 0)) throw new Error("Inspection returned no source content.");
    const receipt: InspectionReceipt = { version: 1, kind: "source", id: randomUUID(), root, sessionId: input.sessionId, planId: input.planId, snapshot, createdAt: new Date().toISOString(), files: files.map(({ content: _content, ...file }) => file) };
    if (this.receipts.size >= 1000) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(receipt.id, structuredClone(receipt));
    return { receipt, files };
  }

  async visual(input: { root: string; sessionId: string; planId: string; artifactPath?: string; captureUrl?: string; route: string; viewport: { width: number; height: number }; observations?: string }) {
    if (!input.sessionId || !input.planId || !input.route?.trim() || input.route.length > 2000 || (input.observations?.length ?? 0) > 8000) throw new Error("Visual evidence needs bounded route and session context.");
    if (!input.viewport || ![input.viewport.width, input.viewport.height].every((value) => Number.isInteger(value) && value > 0 && value <= 8192)) throw new Error("Invalid reported viewport.");
    const root = await fs.realpath(input.root);
    const snapshot = await workspaceSnapshot(root);
    let artifactPath: string;
    let bytes: Buffer;
    let provenance: VisualReceipt["provenance"];
    if (input.captureUrl) {
      artifactPath = input.artifactPath ? path.resolve(input.artifactPath) : path.join(root, ".pi", "pi-workbench", `visual-capture-${randomUUID()}.png`);
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      ({ bytes } = await this.capture({ url: input.captureUrl, viewport: input.viewport, outputPath: artifactPath }));
      provenance = "host-captured-image";
    } else {
      if (!input.artifactPath) throw new Error("Visual inspection requires a PNG artifact, reported route, and viewport.");
      artifactPath = path.resolve(root, input.artifactPath);
      const handle = await fs.open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 45 || stat.size > 8 * 1024 * 1024) throw new Error("Visual evidence requires a regular PNG up to 8 MiB.");
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error("Visual evidence changed during reading.");
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Visual evidence changed during reading.");
      } finally { await handle.close(); }
      provenance = "caller-supplied-image";
    }
    if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024) throw new Error("Visual evidence requires a regular PNG up to 8 MiB.");
    const dimensions = pngDimensions(bytes);
    if (snapshot !== await workspaceSnapshot(root)) throw new Error("Workspace changed during visual registration.");
    const receipt: VisualReceipt = { version: 1, kind: "visual", id: randomUUID(), root, sessionId: input.sessionId, planId: input.planId, snapshot, createdAt: new Date().toISOString(), artifactPath, digest: hash(bytes), ...dimensions, reported: { route: input.route, viewport: { ...input.viewport }, observations: input.observations ?? "" }, provenance };
    if (this.receipts.size >= 1000) this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(receipt.id, structuredClone(receipt));
    return { receipt, image: { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") } };
  }

  async assertCurrent(input: { root: string; sessionId: string; planId: string; ids: string[]; requireVisual?: boolean; requireHostCaptured?: boolean }): Promise<SupervisionReceipt[]> {
    if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 100) throw new Error("Native parent inspection evidence IDs are required.");
    const root = await fs.realpath(input.root);
    const snapshot = await workspaceSnapshot(root);
    const receipts = [...new Set(input.ids)].map((id) => {
      const receipt = this.receipts.get(id);
      if (!receipt || receipt.root !== root || receipt.sessionId !== input.sessionId || receipt.planId !== input.planId) throw new Error("Unknown or foreign parent inspection evidence.");
      if (receipt.snapshot !== snapshot) throw new Error("Parent inspection evidence is stale; inspect the current workspace.");
      return structuredClone(receipt);
    });
    if (!receipts.some((receipt) => receipt.kind === "source")) throw new Error("Current source inspection evidence is required.");
    if (input.requireVisual && !receipts.some((receipt) => receipt.kind === "visual")) throw new Error("Current visual evidence is required for this task.");
    if (input.requireHostCaptured) {
      const visual = receipts.find((receipt) => receipt.kind === "visual");
      if (!visual || visual.kind !== "visual" || visual.provenance !== "host-captured-image") throw new Error("Visual plans require host-captured loopback screenshots.");
      if (!visual.reported.observations.trim()) throw new Error("Visual plans require observed interactions on the captured surface.");
    }
    return receipts;
  }
}
