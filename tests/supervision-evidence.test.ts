import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { captureSupervisionInventory, compareSupervisionInventories, InspectionEvidenceStore } from "../supervision-evidence.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(git = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-supervision-"));
  roots.push(root);
  if (git) execFileSync("git", ["init", "-q", root]);
  await fs.writeFile(path.join(root, "code.txt"), "source\n");
  return root;
}
function commit(root: string) {
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
}

test("handoff compares dirty baseline and retains committed child changes", async () => {
  const root = await fixture();
  commit(root);
  await fs.writeFile(path.join(root, "dirty.txt"), "unrelated existing work");
  const before = await captureSupervisionInventory(root);
  await fs.writeFile(path.join(root, "code.txt"), "child update");
  commit(root);
  const result = compareSupervisionInventories(before, await captureSupervisionInventory(root));
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error(result.error);
  expect(result.changes).toEqual([{ path: "code.txt", kind: "modified" }]);
  expect(result.authorship).toBe("unattributed");
});

test("inventory reports binary additions, deletes and moves without inventing rename attribution", async () => {
  const root = await fixture();
  const before = await captureSupervisionInventory(root);
  await fs.rename(path.join(root, "code.txt"), path.join(root, "moved.txt"));
  await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0, 255, 2]));
  const result = compareSupervisionInventories(before, await captureSupervisionInventory(root));
  if (result.status !== "available") throw new Error(result.error);
  expect(result.changes).toEqual([{ path: "code.txt", kind: "deleted" }, { path: "image.bin", kind: "added" }, { path: "moved.txt", kind: "added" }]);
});

test("deletion inventory supports committed and non-Git deletions without claiming source content", async () => {
  for (const git of [true, false]) {
    const root = await fixture(git);
    await fs.writeFile(path.join(root, "kept.txt"), "unchanged");
    if (git) commit(root);
    const before = await captureSupervisionInventory(root);
    await fs.unlink(path.join(root, "code.txt"));
    if (git) commit(root);
    const store = new InspectionEvidenceStore();
    const context = { root, sessionId: "parent", planId: "plan" };
    const { receipt, files } = await store.inspectChanges({ ...context, before });
    expect(receipt.contentCategory).toBe("deletion-inventory");
    expect(JSON.parse(files[0].content).deleted.map((file: { path: string }) => file.path)).toEqual(["code.txt"]);
    expect(files[0].content).toContain("deleted source content was not returned");
    expect((await store.assertCurrent({ ...context, ids: [receipt.id] }))[0].id).toBe(receipt.id);
    await expect(store.inspectChanges(context)).rejects.toThrow("host baseline");
  }
});

test("inventory metadata cannot bypass reading added or modified source", async () => {
  const root = await fixture(false);
  const before = await captureSupervisionInventory(root);
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan" };
  await expect(store.inspectChanges({ ...context, before })).rejects.toThrow("No deletion-only");
  await fs.writeFile(path.join(root, "code.txt"), "changed");
  await expect(store.inspectChanges({ ...context, before })).rejects.toThrow("requires source inspection");
  await fs.unlink(path.join(root, "code.txt"));
  await fs.writeFile(path.join(root, "new.txt"), "new");
  await expect(store.inspectChanges({ ...context, before })).rejects.toThrow("requires source inspection");
  await fs.unlink(path.join(root, "new.txt"));
  const { receipt } = await store.inspectChanges(context);
  expect(receipt.contentCategory).toBe("empty-inventory");
  expect((await store.assertCurrent({ ...context, ids: [receipt.id] }))[0].id).toBe(receipt.id);
});

test("non-Git inventory excludes native artifacts and distinguishes broken collection", async () => {
  const root = await fixture(false);
  const before = await captureSupervisionInventory(root);
  await fs.mkdir(path.join(root, ".pi/pi-workbench"), { recursive: true });
  await fs.writeFile(path.join(root, ".pi/pi-workbench/evidence.json"), "{}");
  const unchanged = compareSupervisionInventories(before, await captureSupervisionInventory(root));
  expect(unchanged.status === "available" && unchanged.changes).toEqual([]);
  await fs.writeFile(path.join(root, ".git"), "gitdir: /nonexistent-workbench-git\n");
  const unavailable = await captureSupervisionInventory(root);
  expect(unavailable.status).toBe("unavailable");
  expect(compareSupervisionInventories(before, unavailable).status).toBe("unavailable");
});

test("inspection binds actual bounded returned content to parent, plan and current workspace", async () => {
  const root = await fixture();
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan" };
  const { receipt, files } = await store.inspect({ ...context, paths: ["code.txt"], maxBytes: 3 });
  expect(files[0].content).toBe("sou");
  expect(receipt.files[0].bytesReturned).toBe(3);
  expect(receipt.files[0].truncated).toBe(true);
  const ids = [receipt.id];
  expect((await store.assertCurrent({ ...context, ids }))[0].id).toBe(receipt.id);
  await expect(store.assertCurrent({ ...context, sessionId: "child", ids })).rejects.toThrow("foreign");
  await expect(store.assertCurrent({ ...context, planId: "other", ids })).rejects.toThrow("foreign");
  await expect(store.assertCurrent({ ...context, ids: ["fabricated"] })).rejects.toThrow("Unknown");
  await fs.writeFile(path.join(root, "code.txt"), "changed");
  await expect(store.assertCurrent({ ...context, ids })).rejects.toThrow("stale");
});

test("caller cannot rewrite native receipt and clearing session invalidates evidence", async () => {
  const root = await fixture();
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan" };
  const { receipt } = await store.inspect({ ...context, paths: ["code.txt"] });
  receipt.sessionId = "forged";
  expect((await store.assertCurrent({ ...context, ids: [receipt.id] }))[0].sessionId).toBe("parent");
  store.clear();
  await expect(store.assertCurrent({ ...context, ids: [receipt.id] })).rejects.toThrow("Unknown");
});

test("inspection keeps UTF-8 output within budget and reports truncation", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "code.txt"), "a🙂z");
  const store = new InspectionEvidenceStore();
  const { files } = await store.inspect({ root, sessionId: "parent", planId: "plan", paths: ["code.txt"], maxBytes: 4 });
  expect(files[0].content).toBe("a");
  expect(files[0].bytesReturned).toBe(1);
  expect(files[0].truncated).toBe(true);
});

test("source inspection returns a bounded requested line range and refuses an absent range", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "code.txt"), Array.from({ length: 101 }, (_, index) => `line ${index + 1}`).join("\n"));
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan", paths: ["code.txt"] };
  const { receipt, files } = await store.inspect({ ...context, startLine: 100, maxBytes: 8 });
  expect(files[0].content).toBe("line 100");
  expect(receipt.files[0].startLine).toBe(100);
  expect(receipt.files[0].truncated).toBe(true);
  await expect(store.inspect({ ...context, startLine: 102 })).rejects.toThrow("outside");
  await expect(store.inspect({ ...context, startLine: 0 })).rejects.toThrow("startLine");
});

test("inspection refuses escaped, linked, binary and empty evidence", async () => {
  const root = await fixture();
  const outside = await fixture(false);
  await fs.symlink(path.join(outside, "code.txt"), path.join(root, "link.txt"));
  await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
  await fs.writeFile(path.join(root, "empty"), "");
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan" };
  for (const name of [path.join(outside, "code.txt"), "link.txt", "binary", "empty"]) {
    await expect(store.inspect({ ...context, paths: [name] })).rejects.toThrow();
  }
  await expect(store.assertCurrent({ ...context, ids: [] })).rejects.toThrow("required");
});

function png() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

test("visual registration returns validated image bytes and separates reports from host facts", async () => {
  const root = await fixture();
  const directory = await fixture(false);
  const artifactPath = path.join(directory, "capture.png");
  const bytes = png();
  await fs.writeFile(artifactPath, bytes);
  const store = new InspectionEvidenceStore();
  const context = { root, sessionId: "parent", planId: "plan" };
  const source = await store.inspect({ ...context, paths: ["code.txt"] });
  await expect(store.assertCurrent({ ...context, ids: [source.receipt.id], requireVisual: true })).rejects.toThrow("visual evidence");
  const { receipt, image } = await store.visual({ ...context, artifactPath, route: "/projects", viewport: { width: 390, height: 844 }, observations: "Caller reports keyboard worked" });
  expect(Buffer.from(image.data, "base64")).toEqual(bytes);
  expect(receipt.width).toBe(1);
  expect(receipt.reported.viewport.width).toBe(390);
  expect(receipt.provenance).toBe("caller-supplied-image");
  await expect(store.assertCurrent({ ...context, ids: [receipt.id], requireVisual: true })).rejects.toThrow("source inspection");
  expect((await store.assertCurrent({ ...context, ids: [source.receipt.id, receipt.id], requireVisual: true }))[1].kind).toBe("visual");
  await fs.writeFile(path.join(root, "code.txt"), "different build");
  await expect(store.assertCurrent({ ...context, ids: [receipt.id], requireVisual: true })).rejects.toThrow("stale");
});

test("visual evidence rejects corrupt, truncated, symlink and non-image artifacts", async () => {
  const root = await fixture();
  const directory = await fixture(false);
  const artifactPath = path.join(directory, "capture.png");
  const context = { root, sessionId: "parent", planId: "plan", artifactPath, route: "/", viewport: { width: 100, height: 100 } };
  const store = new InspectionEvidenceStore();
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  for (const bytes of [corrupt, png().subarray(0, 50), Buffer.alloc(100)]) {
    await fs.writeFile(artifactPath, bytes);
    await expect(store.visual(context)).rejects.toThrow();
  }
  await fs.writeFile(artifactPath, png());
  const link = path.join(directory, "link.png");
  await fs.symlink(artifactPath, link);
  await expect(store.visual({ ...context, artifactPath: link })).rejects.toThrow();
  await expect(store.visual({ ...context, artifactPath: directory })).rejects.toThrow();
});
