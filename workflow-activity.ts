import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

interface Activity { message: string; startedAt: number }
interface Display { entries: Activity[]; dispose?: () => void }
const displays = new WeakMap<ExtensionContext["ui"], Display>();
const KEY = "workbench-activity";

/** A visible loader even while a slash command awaits a child and Main Pi is idle. */
export function startWorkflowActivity(ctx: ExtensionContext, message: string) {
  const entry: Activity = { message, startedAt: Date.now() };
  let stopped = !ctx.hasUI;
  const display = displays.get(ctx.ui) ?? { entries: [] };
  if (!stopped) { displays.set(ctx.ui, display); display.entries.push(entry); }

  const render = () => {
    if (!ctx.hasUI) return;
    display.dispose?.();
    display.dispose = undefined;
    const current = display.entries.at(-1);
    if (!current) {
      ctx.ui.setStatus(KEY, undefined);
      ctx.ui.setWidget?.(KEY, undefined);
      displays.delete(ctx.ui);
      return;
    }
    ctx.ui.setStatus(KEY, current.message);
    if (ctx.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
    ctx.ui.setWidget(KEY, (tui, theme) => {
      const label = () => `${current.message} · ${Math.floor((Date.now() - current.startedAt) / 1000)}s`;
      const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), label());
      const timer = setInterval(() => loader.setMessage(label()), 1000);
      timer.unref?.();
      const dispose = () => { clearInterval(timer); loader.stop(); };
      display.dispose = dispose;
      return { render: (width) => loader.render(width), invalidate: () => loader.invalidate(), dispose };
    }, { placement: "aboveEditor" });
  };
  render();
  return {
    update(next: string) { if (!stopped) { entry.message = next; render(); } },
    stop() {
      if (stopped) return;
      stopped = true;
      const index = display.entries.indexOf(entry);
      if (index >= 0) display.entries.splice(index, 1);
      render();
    },
  };
}
