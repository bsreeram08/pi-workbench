import { describe, expect, test } from "bun:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
  WORKBENCH_ORIENTATION,
  WORKBENCH_SESSION_BLURB,
  formatHelp,
  listHelpTopics,
  registerWorkbenchHelp,
} from "../workbench-help.ts";

const discovered: SlashCommandInfo[] = [
  { name: "plan", description: "plan", source: "extension", sourceInfo: { path: "index.ts", source: "ext", scope: "user", origin: "package" } },
  { name: "my-skill", description: "A skill", source: "skill", sourceInfo: { path: "SKILL.md", source: "skill", scope: "user", origin: "top-level" } },
  { name: "draft", description: "A prompt", source: "prompt", sourceInfo: { path: "draft.md", source: "prompt", scope: "project", origin: "top-level" } },
];

describe("workbench help catalog", () => {
  test("index lists the coordinator loop and every catalogued command", () => {
    const index = formatHelp("");
    expect(index).toContain("/plan");
    expect(index).toContain("/plan-ui");
    expect(index).toContain("/start-work");
    expect(index).toContain("/help all");
    expect(index).toContain("/delegate");
    expect(index).toContain("/spawn");
    expect(index).toContain("/research");
    expect(index).toContain("/council");
  });

  test("topic help covers plan flags, visual capture, and unknown topics", () => {
    expect(formatHelp("plan-ui")).toContain("/plan-ui");
    expect(formatHelp("visual")).toContain("host-captured");
    expect(formatHelp("3d")).toContain("2D capture");
    expect(formatHelp("nope")).toContain("Unknown help topic");
    expect(listHelpTopics()).toContain("plan");
    expect(listHelpTopics()).toContain("all");
  });

  test("help all lists discovered extension, prompt, and skill commands", () => {
    const all = formatHelp("all", discovered);
    expect(all).toContain("/plan");
    expect(all).toContain("/my-skill");
    expect(all).toContain("/draft");
    expect(formatHelp("skill", discovered)).toContain("/my-skill");
    expect(formatHelp("skill", discovered)).not.toContain("/plan");
  });
});

describe("workbench help registration", () => {
  function harness() {
    const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const reports: Array<{ title: string; body: string }> = [];
    const pi = {
      getCommands: () => discovered,
      registerCommand(name: string, command: { description: string; handler: (args: string, ctx: any) => Promise<void> }) {
        commands.set(name, command);
      },
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any;
    const ctx = { hasUI: true, ui: { setStatus() {} } };
    registerWorkbenchHelp(pi, (title, body) => reports.push({ title, body }));
    return { commands, handlers, reports, ctx };
  }

  test("registers help aliases and prints the catalog", async () => {
    const item = harness();
    expect([...item.commands.keys()]).toEqual(["help", "commands", "workbench"]);
    await item.commands.get("help")?.handler("", item.ctx);
    expect(item.reports.at(-1)?.title).toBe("Workbench help");
    expect(item.reports.at(-1)?.body).toContain("/plan-ui");
    await item.commands.get("commands")?.handler("", item.ctx);
    expect(item.reports.at(-1)?.body).toContain("/my-skill");
  });

  test("startup teaches the loop; reload does not repeat the blurb", async () => {
    const item = harness();
    await item.handlers.get("session_start")?.[0]?.({ reason: "startup" }, item.ctx);
    expect(item.reports).toEqual([{ title: "Pi Workbench", body: WORKBENCH_SESSION_BLURB }]);
    await item.handlers.get("session_start")?.[0]?.({ reason: "reload" }, item.ctx);
    expect(item.reports).toHaveLength(1);
  });

  test("Main Pi receives orientation so it can teach the workbench", async () => {
    const item = harness();
    const injected = await item.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, item.ctx) as { systemPrompt: string };
    expect(injected.systemPrompt).toStartWith("base\n\n");
    expect(injected.systemPrompt).toContain(WORKBENCH_ORIENTATION);
    const skipped = await item.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: `base\n\n${WORKBENCH_ORIENTATION}` }, item.ctx);
    expect(skipped).toBeUndefined();
  });
});
