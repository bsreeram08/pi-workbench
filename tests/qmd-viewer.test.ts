import { describe, expect, test } from "bun:test";
import { parseQmdCollectionList, parseQmdLs, qmdViewerPayload } from "../qmd-viewer.ts";

const listText = `
Collections
  DineManage (qmd://DineManage/)
    Pattern:  **/*.md
    Files:    103 (updated 10d ago)
  flows (qmd://flows/)
    Pattern:  **/*.md
    Files:    0 (updated never)
  pi-workbench-project-23ef9a2d34 (qmd://pi-workbench-project-23ef9a2d34/)
    Pattern:  **/*.md
    Files:    6 (updated 213d ago)
`;

const lsText = `
 6.2 KB  Aug 31 17:28  qmd://DineManage/agents.md
 1.4 KB  Aug 31 17:28  qmd://DineManage/apps/docs/readme.md
`;

describe("QMD viewer", () => {
  test("parses collection cards including empty and workbench hashes", () => {
    const cards = parseQmdCollectionList(listText);
    expect(cards.map((item) => [item.name, item.files, item.empty, item.workbench])).toEqual([
      ["DineManage", 103, false, false],
      ["flows", 0, true, false],
      ["pi-workbench-project-23ef9a2d34", 6, false, true],
    ]);
  });

  test("parses ls rows", () => {
    expect(parseQmdLs(lsText)).toEqual([
      { uri: "qmd://DineManage/agents.md", path: "agents.md", size: "6.2 KB", updated: "Aug 31 17:28" },
      { uri: "qmd://DineManage/apps/docs/readme.md", path: "apps/docs/readme.md", size: "1.4 KB", updated: "Aug 31 17:28" },
    ]);
  });

  test("rejects unsafe collection and document ids", async () => {
    const exec = async () => ({ stdout: "", stderr: "", code: 0 });
    expect((await qmdViewerPayload("/api/files", new URLSearchParams("collection=../secret"), exec)).status).toBe(400);
    expect((await qmdViewerPayload("/api/doc", new URLSearchParams("id=/etc/passwd"), exec)).status).toBe(400);
    expect((await qmdViewerPayload("/api/doc", new URLSearchParams("id=qmd://x/../../etc"), exec)).status).toBe(400);
  });

  test("lists collections through qmd exec", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      expect(args).toEqual(["collection", "list"]);
      return { stdout: listText, stderr: "", code: 0 };
    };
    const payload = await qmdViewerPayload("/api/collections", new URLSearchParams(), exec);
    expect(payload.status).toBe(200);
    expect("body" in payload && (payload.body as { collections: { name: string }[] }).collections[0]?.name).toBe("DineManage");
  });
});
