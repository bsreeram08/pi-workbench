import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildImpactReceipt,
  formatImpactReceiptForReview,
  type ImpactReceipt,
} from "../impact-receipt.ts";
import { buildCodeReviewTask } from "../workflow-prompts.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-impact-"));
  roots.push(root);
  return root;
}

function available(paths: Array<{ path: string; kind: "added" | "deleted" | "modified" }>) {
  return { status: "available" as const, changes: paths };
}

test("changed file is tested when a test file appears in dependents within depth 3", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/a.ts"), "export function foo() {}\n");
  await fs.writeFile(path.join(root, "src/b.ts"), 'import { foo } from "./a";\nexport function bar() {}\n');
  await fs.writeFile(path.join(root, "src/b.test.ts"), 'import { bar } from "./b";\n');
  const receipt = await buildImpactReceipt({
    root,
    snapshot: "snap-a",
    changes: available([{ path: "src/a.ts", kind: "modified" }]),
  });
  expect(receipt.status).toBe("available");
  expect(receipt.entities).toEqual([{
    path: "src/a.ts",
    name: "foo",
    kind: "function",
    change: "modified",
    startLine: 1,
    endLine: 1,
  }]);
  expect(receipt.dependents).toEqual([
    { path: "src/b.ts", depth: 1 },
    { path: "src/b.test.ts", depth: 2 },
  ]);
  expect(receipt.untestedChangedFiles).toEqual([]);
  expect(receipt.blastRadius.level).toBe("medium");
});

test("changed file with no importers is untested and blast radius is low", async () => {
  const root = await fixture();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src/c.ts"), "export function lone() {}\n");
  const receipt = await buildImpactReceipt({
    root,
    snapshot: "snap-c",
    changes: available([{ path: "src/c.ts", kind: "modified" }]),
  });
  expect(receipt.status).toBe("available");
  expect(receipt.dependents).toEqual([]);
  expect(receipt.untestedChangedFiles).toEqual(["src/c.ts"]);
  expect(receipt.blastRadius.level).toBe("low");
});

test("relative import that escapes the project root is ignored", async () => {
  const base = await fixture();
  const root = path.join(base, "project");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(base, "out.ts"), "export function outside() {}\n");
  await fs.writeFile(path.join(root, "src/inside.ts"), 'import { outside } from "../out";\nexport function inside() {}\n');
  const receipt = await buildImpactReceipt({
    root,
    snapshot: "snap-out",
    changes: available([{ path: "src/inside.ts", kind: "modified" }]),
  });
  expect(receipt.status).toBe("available");
  expect(receipt.entities.map((item) => item.name)).toEqual(["inside"]);
  expect(receipt.dependents).toEqual([]);
  expect(receipt.changedPaths.every((item) => !item.includes("out.ts"))).toBe(true);
});

test("only markdown changed stays available with empty entities", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "README.md"), "# notes\n");
  const receipt = await buildImpactReceipt({
    root,
    snapshot: "snap-md",
    changes: available([{ path: "README.md", kind: "modified" }]),
  });
  expect(receipt.status).toBe("available");
  expect(receipt.entities).toEqual([]);
  expect(receipt.dependents).toEqual([]);
  expect(receipt.blastRadius.level).toBe("low");
});

test("unavailable inventory compare yields an unavailable receipt", async () => {
  const receipt = await buildImpactReceipt({
    root: await fixture(),
    snapshot: "snap-u",
    changes: { status: "unavailable", error: "inventory project roots differ." },
  });
  expect(receipt.status).toBe("unavailable");
  expect(receipt.reason).toBe("inventory project roots differ.");
});

test("formatImpactReceiptForReview includes HOST IMPACT RECEIPT and prints unavailable reason", () => {
  const availableReceipt: ImpactReceipt = {
    version: 1,
    status: "available",
    snapshot: "abc",
    changedPaths: ["src/a.ts"],
    entities: [{ path: "src/a.ts", name: "foo", kind: "function", change: "modified", startLine: 1, endLine: 1 }],
    dependents: [{ path: "src/b.ts", depth: 1 }],
    blastRadius: { level: "medium", criticalPaths: [] },
    untestedChangedFiles: [],
  };
  const formatted = formatImpactReceiptForReview(availableReceipt);
  expect(formatted.startsWith("HOST IMPACT RECEIPT (navigation only; not proof of correctness or completion):")).toBe(true);
  expect(formatted).toContain('"name":"foo"');
  const unavailableText = formatImpactReceiptForReview({
    ...availableReceipt,
    status: "unavailable",
    reason: "no-parseable-sources",
  });
  expect(unavailableText).toContain("HOST IMPACT RECEIPT");
  expect(unavailableText).toContain('"status":"unavailable"');
  expect(unavailableText).toContain("no-parseable-sources");
  expect(unavailableText).not.toContain("src/a.ts");
});

test("buildCodeReviewTask prepends the receipt and still ends with findings then verdict", () => {
  const receipt: ImpactReceipt = {
    version: 1,
    status: "available",
    snapshot: "abc",
    changedPaths: ["src/a.ts"],
    entities: [{ path: "src/a.ts", name: "foo", kind: "function", change: "modified", startLine: 1, endLine: 1 }],
    dependents: [{ path: "src/b.ts", depth: 1 }],
    blastRadius: { level: "medium", criticalPaths: [] },
    untestedChangedFiles: [],
  };
  const prompt = buildCodeReviewTask("quality-reviewer", "task", "plan", "implementation", undefined, receipt);
  expect(prompt).toContain("HOST IMPACT RECEIPT (navigation only; not proof of correctness or completion):");
  expect(prompt.indexOf("HOST IMPACT RECEIPT")).toBeLessThan(prompt.indexOf("USER TASK:"));
  expect(prompt.indexOf("<workflow-findings>")).toBeGreaterThan(prompt.indexOf("USER TASK:"));
  expect(prompt.indexOf("<code-verdict>")).toBeGreaterThan(prompt.indexOf("<workflow-findings>"));
  expect(prompt.trimEnd().endsWith("<code-verdict>BLOCKED</code-verdict>") || prompt.includes("<code-verdict>PASS</code-verdict>")).toBe(true);
  expect(buildCodeReviewTask("quality-reviewer", "task", "plan", "implementation")).not.toContain("HOST IMPACT RECEIPT");
});
