import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const commands = pi.getCommands();
        const skills = commands.filter((command) => command.source === "skill").length;
        const prompts = commands.filter((command) => command.source === "prompt").length;
        const summary = `${skills} skills · ${prompts} prompts · ${pi.getActiveTools().length} tools`;

        const art = [
          ["█████", "     ", "████  ████  █████ █████"],
          [" █ █", "      ", "█     █   █ █     █"],
          [" █ █", "      ", " ███  ████  ████  ████"],
          [" █ █", "      ", "    █ █  █  █     █"],
          [" █ █", "      ", "████  █   █ █████ █████"],
        ].map(([symbol, gap, name]) =>
          theme.fg("accent", symbol) + gap + theme.bold(theme.fg("text", name)),
        );

        return [
          "",
          ...art,
          theme.fg("muted", `${summary}`) + theme.fg("dim", ` · /help · pi v${VERSION}`),
          "",
        ].map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
    }));
  });
}
