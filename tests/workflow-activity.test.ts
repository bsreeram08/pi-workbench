import { expect, test } from "bun:test";
import { startWorkflowActivity } from "../workflow-activity.ts";

test("activity is visible while Main Pi is idle, restores its parent phase, and disposes animation", async () => {
  let widget: { render(width: number): string[]; dispose(): void } | undefined;
  let renders = 0;
  const statuses: Array<string | undefined> = [];
  const ctx = {
    hasUI: true, mode: "tui",
    ui: {
      setStatus(_key: string, value: string | undefined) { statuses.push(value); },
      setWidget(_key: string, factory: any) {
        widget?.dispose();
        widget = factory?.({ requestRender() { renders++; } }, { fg(_name: string, text: string) { return text; } });
      },
    },
  } as any;
  const parent = startWorkflowActivity(ctx, "Coordinator: planning");
  const initialRenders = renders;
  try {
    expect(widget?.render(100).join("\n")).toContain("Coordinator: planning · 0s");
    await Bun.sleep(100);
    expect(renders).toBeGreaterThan(initialRenders);
    const child = startWorkflowActivity(ctx, "Technical Reviewer: reviewing");
    expect(widget?.render(100).join("\n")).toContain("Technical Reviewer: reviewing");
    child.stop();
    expect(widget?.render(100).join("\n")).toContain("Coordinator: planning");
    parent.stop();
    expect(widget).toBeUndefined();
    expect(statuses.at(-1)).toBeUndefined();
    const stoppedRenders = renders;
    await Bun.sleep(100);
    expect(renders).toBe(stoppedRenders);
    parent.stop();
  } finally { parent.stop(); widget?.dispose(); }
});

test("noninteractive activity does not touch UI or start a loader", () => {
  const activity = startWorkflowActivity({ hasUI: false, mode: "rpc", ui: {} } as any, "Working");
  activity.update("Reviewing");
  activity.stop();
});
