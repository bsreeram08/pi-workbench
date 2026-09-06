import { expect, test } from "bun:test";
import { registerPromptEditor } from "../prompt-editor.ts";

function setup(context?: (ctx: any) => Promise<string>) {
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const events = new Map<string, Array<(...args: any[]) => void>>();
  const messages: Array<{ text: string; options: any }> = [];
  const reports: Array<{ title: string; body: string }> = [];
  const writes: string[] = [];
  const modalCalls: any[][] = [];
  let editor = "";
  let modal: string | undefined;
  const ctx: any = { cwd: "/project", hasUI: true, isProjectTrusted: () => true,
    ui: { getEditorText: () => editor, setEditorText: (value: string) => { editor = value; writes.push(value); },
      editor: async (...args: any[]) => { modalCalls.push(args); return modal; },
      setStatus() {}, notify() {}, confirm: async () => true,
    },
  };
  registerPromptEditor({
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => events.set(name, [...(events.get(name) ?? []), handler]),
    sendUserMessage: (text: string, options: any) => messages.push({ text, options }),
  } as any, { context, report: (title, body) => reports.push({ title, body }) });
  const run = (action: string, extra: object = {}, signal?: AbortSignal) => tools.get("workbench_prompt").execute("test", { action, ...extra }, signal, undefined, ctx);
  return {
    commands, messages, reports, writes, modalCalls, ctx, run,
    command: (name: string, args = "") => commands.get(name).handler(args, ctx),
    status: async () => (await run("status")).details,
    preview: (requestId: string, improved = "Improved request") => run("preview", { requestId, improved, changes: ["Clarified outcome"], assumptions: [], questions: [] }),
    type: (value: string) => { editor = value; },
    editor: () => editor,
    modal: (value: string | undefined) => { modal = value; },
    reload: () => { for (const handler of events.get("session_start") ?? []) handler({}, ctx); },
  };
}

test("prompt aliases queue Main Pi in the selected mode without replacing the editor", async () => {
  for (const [command, mode] of [["improve-prompt", "improve"], ["improveprompt", "improve"], ["enhance-prompt", "enhance"], ["enhance", "enhance"], ["reprompt", "enhance"]]) {
    const item = setup();
    item.type("Existing unsubmitted work");
    await item.command(command, "Make a useful portfolio");
    const state = await item.status();
    expect(state.mode).toBe(mode);
    expect(state.original).toBe("Make a useful portfolio");
    expect(typeof state.requestId).toBe("string");
    expect(item.messages).toHaveLength(1);
    expect(item.messages[0].options.expandPromptTemplates).toBe(false);
    expect(item.messages[0].options.deliverAs).toBe("followUp");
    expect(item.writes).toEqual([]);
    expect(item.editor()).toBe("Existing unsubmitted work");
  }
});

test("host preserves literal facts, model requests and source constraints through preview", async () => {
  const item = setup(async () => "Project contains resume-data.json; no app yet.");
  const original = "  Use resume-data.json as the sole facts source.\nUse GPT-6 Astra for UI/UX; do not invent employers.\nKeep literal $HOME and $(echo example).  ";
  await item.command("enhance", original);
  const state = await item.status();
  expect(state.original).toBe(original);
  expect(item.messages[0].text).toContain(JSON.stringify(original));
  expect(item.messages[0].text).toContain("resume-data.json; no app yet");
  await item.preview(state.requestId, "A model-written proposed rewrite");
  expect((await item.status()).original).toBe(original);
  expect(item.writes).toEqual([]);
  expect(item.messages).toHaveLength(1);
});

test("overwrite-protection baseline does not expose unrelated unsubmitted editor text to Main Pi", async () => {
  const item = setup();
  const privateDraft = "Unrelated private draft not included in the command";
  item.type(privateDraft);
  await item.command("enhance", "The explicit request to improve");
  const status = await item.status();
  expect(JSON.stringify(status)).not.toContain(privateDraft);
  expect(status.editorBefore).toBeUndefined();
  const preview = await item.preview(status.requestId);
  expect(JSON.stringify(preview)).not.toContain(privateDraft);
  expect(item.messages[0].text).not.toContain(privateDraft);
});

test("prompt-use explicitly fills editor after preview and does not submit work", async () => {
  const item = setup();
  item.type("Original editor content");
  await item.command("improve-prompt");
  const state = await item.status();
  expect(state.original).toBe("Original editor content");
  await item.preview(state.requestId, "A clearer request");
  expect(item.writes).toEqual([]);
  await item.command("prompt-use");
  expect(item.writes).toEqual(["A clearer request"]);
  expect(item.messages).toHaveLength(1);
});

test("empty prompt opens editor once and cancelled input creates no request", async () => {
  const item = setup();
  item.modal(undefined);
  await item.command("enhance");
  expect(item.modalCalls).toHaveLength(1);
  expect(item.messages).toEqual([]);
  item.modal("Build a flight journey");
  await item.command("enhance");
  expect((await item.status()).original).toBe("Build a flight journey");
  expect(item.messages).toHaveLength(1);
});

test("prompt-use refuses to overwrite newly typed text but permits a cleared editor", async () => {
  const item = setup();
  item.type("Original draft");
  await item.command("enhance", "Improve the task");
  await item.preview((await item.status()).requestId);
  item.type("New user text typed while AI worked");
  await item.command("prompt-use");
  expect(item.writes).toEqual([]);
  expect(item.editor()).toBe("New user text typed while AI worked");
  expect(item.reports.length).toBeGreaterThan(0);
  item.type("");
  await item.command("prompt-use");
  expect(item.editor()).toBe("Improved request");
});

test("stale, fabricated and session-reset previews cannot replace the latest request", async () => {
  const item = setup();
  await item.command("enhance", "First request");
  const old = (await item.status()).requestId;
  await item.command("enhance", "Second request");
  const current = (await item.status()).requestId;
  expect(current).not.toBe(old);
  await expect(item.preview(old)).rejects.toThrow();
  await expect(item.preview("fabricated")).rejects.toThrow();
  expect((await item.status()).original).toBe("Second request");
  item.reload();
  await expect(item.preview(current)).rejects.toThrow();
  await item.command("prompt-use");
  expect(item.writes).toEqual([]);
});

test("prompt drafts cannot be previewed or inserted from another project context", async () => {
  const item = setup();
  await item.command("enhance", "Project-specific request");
  const id = (await item.status()).requestId;
  await item.preview(id);
  item.ctx.cwd = "/another-project";
  expect(JSON.stringify(await item.status())).not.toContain("Project-specific request");
  await expect(item.preview(id)).rejects.toThrow();
  await item.command("prompt-use");
  expect(item.writes).toEqual([]);
});

test("aborted and malformed preview cannot authorize editor insertion", async () => {
  const item = setup();
  await item.command("improveprompt", "Original");
  const requestId = (await item.status()).requestId;
  const controller = new AbortController(); controller.abort();
  await expect(item.run("preview", { requestId, improved: "Replacement", changes: [], assumptions: [], questions: [] }, controller.signal)).rejects.toThrow();
  for (const invalid of [{ improved: "" }, { improved: "Good", changes: "not an array" }, { improved: "Good", questions: [1] }, { improved: "x".repeat(32_769) },
    { improved: "Good", assumptions: Array(9).fill("assumption") }, { improved: "Good", changes: ["x".repeat(501)] }]) {
    await expect(item.run("preview", { requestId, changes: [], assumptions: [], questions: [], ...invalid })).rejects.toThrow();
  }
  await item.command("prompt-use");
  expect(item.writes).toEqual([]);
});

test("input and project context remain bounded", async () => {
  const item = setup(async () => "C".repeat(20_000));
  await item.command("enhance", "x".repeat(16_385));
  expect(item.messages).toEqual([]);
  await item.command("enhance", "🙂".repeat(5000));
  expect(item.messages).toEqual([]);
  await item.command("enhance", "Short task");
  expect(item.messages).toHaveLength(1);
  expect(item.messages[0].text).not.toContain("C".repeat(8_193));
});

test("editor baseline is captured before slow project context collection", async () => {
  let release!: (value: string) => void;
  const item = setup(async () => new Promise<string>((resolve) => { release = resolve; }));
  item.type("Original draft");
  const pending = item.command("enhance", "Requested enhancement");
  await Promise.resolve();
  item.type("User typed this during collection");
  release("Project context"); await pending;
  await item.preview((await item.status()).requestId);
  await item.command("prompt-use");
  expect(item.writes).toEqual([]);
  expect(item.editor()).toBe("User typed this during collection");
});

test("an earlier slow context collection cannot displace the newest command", async () => {
  let release!: (value: string) => void;
  let calls = 0;
  const item = setup(async () => ++calls === 1 ? new Promise<string>((resolve) => { release = resolve; }) : "new context");
  const old = item.command("enhance", "Old request");
  await Promise.resolve();
  await item.command("enhance", "Newest request");
  release("old context"); await old;
  expect((await item.status()).original).toBe("Newest request");
  expect(item.messages).toHaveLength(1);
  expect(item.messages[0].text).toContain("Newest request");
});
