import type { ExtensionAPI, ExtensionCommandContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export const WORKBENCH_HELP_ENTRY = "pi-workbench-help";

export interface HelpCommand {
  name: string;
  usage: string;
  summary: string;
  details?: string;
  aliases?: string[];
}

export interface HelpGroup {
  id: string;
  title: string;
  commands: HelpCommand[];
}

export const WORKBENCH_ORIENTATION = `## Pi Workbench

You are the Coordinator in this session. When the user is new, lost, or asks how this works, teach the loop below and point them to \`/help\`. Do not dump the full catalog unless they ask.

Default path: \`/plan <task>\` → independent review → user approve → \`/start-work\`. Do not implement from a planning request. UI work: \`/plan-ui <task>\` — taste lock and host loopback capture are required; tests are not completion. A 3D canvas still uses that 2D capture; say so if the scene needs camera or WebGL evidence.

Specialists: \`delegate_task\` or \`/delegate\`. Spawn policy: \`/spawn\`. Persistent read-only agents: \`workbench_agent_*\`. Verification: \`workbench_verify\`. Isolated work: \`./.worktrees/<name>\` inside the project. Do not use the external \`subagent\` tool or \`workflowScript\`.

If they ask what they can type, run or cite \`/help\` (one command: \`/help plan\`; everything Pi discovered: \`/help all\`).`;

export const WORKBENCH_SESSION_BLURB = `**Pi Workbench** — Coordinator session.

Default loop: \`/plan\` then \`/start-work\`. UI: \`/plan-ui\`.
Commands: \`/help\`. One command: \`/help plan\`. Everything discovered: \`/help all\`.`;

export const HELP_GROUPS: HelpGroup[] = [
  {
    id: "plan",
    title: "Plan and ship",
    commands: [
      {
        name: "plan",
        usage: "/plan [--pipeline] [--revise] [task]",
        summary: "Clarify, plan, and independently review. User approval required before implementation.",
        details: "Default Coordinator planning. `--pipeline` uses automatic discovery/planner/review. `--revise` keeps the current draft. For UI work use `/plan-ui`, not `/plan --visual`. Do not implement from this command.",
      },
      {
        name: "plan-ui",
        usage: "/plan-ui [task]",
        summary: "Plan UI work: taste lock + host loopback capture. Same as `/plan`, remainder is the task.",
        details: "Always a visual plan. Type `/plan-ui rebuild the settings page` — no `--visual` flag, no extra prompt box. Empty `/plan-ui` opens the planning editor. `--revise` and `--pipeline` still work on the remainder.",
      },
      {
        name: "start-work",
        usage: "/start-work [--pipeline]",
        summary: "Implement the approved plan with native review and verification.",
        details: "Main Pi directs bounded writers. `--pipeline` uses the automatic implement/review/repair sequence. Visual plans need host-captured loopback screenshots.",
      },
      {
        name: "review",
        usage: "/review [--root <git-toplevel>] [focus]",
        summary: "Independent code review of the current tree. No plan required.",
      },
      {
        name: "autopilot",
        usage: "/autopilot [task]",
        summary: "Plan, implement, review, and verify in one run.",
        details: "Does not auto-enter the visual loop. For UI work use `/autopilot-ui`.",
      },
      {
        name: "autopilot-ui",
        usage: "/autopilot-ui [task]",
        summary: "Autopilot for UI work (taste lock + host capture).",
      },
      {
        name: "workflow-status",
        usage: "/workflow-status",
        summary: "Current plan state and evidence paths.",
      },
    ],
  },
  {
    id: "specialists",
    title: "Specialists",
    commands: [
      { name: "delegate", usage: "/delegate [agent task]", summary: "Roster, or run one specialist (`delegate_task`)." },
      {
        name: "spawn",
        usage: "/spawn [always|ask|never|auto] | fanout <1-6> | this …",
        summary: "When Main Pi may spawn specialists. `never` blocks opportunistic spawn; `/delegate` still runs.",
      },
    ],
  },
  {
    id: "session",
    title: "Session",
    commands: [
      { name: "help", usage: "/help [topic|all]", summary: "This catalog. `/help plan` one command; `/help all` every discovered slash command.", aliases: ["commands", "workbench"] },
      { name: "todos", usage: "/todos", summary: "First-party session todo list." },
      { name: "goals", usage: "/goals", summary: "Show the user-owned Workbench goal." },
      { name: "goals-set", usage: "/goals-set <objective>", summary: "Create or replace the goal. The agent does not create goals." },
      { name: "goals-clear", usage: "/goals-clear", summary: "Remove the goal file." },
      { name: "automode", usage: "/automode [on|off|status]", summary: "Keep this Coordinator session moving with conservative defaults." },
      { name: "model-routing", usage: "/model-routing [grok|codex|balanced|economy|quality] [--default]", summary: "Family/policy for Main Pi and children." },
      { name: "preferences", usage: "/preferences", summary: "Durable user operating preferences." },
      { name: "remember", usage: "/remember [preference]", summary: "Teach an explicit preference." },
      { name: "usage", usage: "/usage", summary: "Coding-plan quota for Codex or xAI." },
    ],
  },
  {
    id: "memory",
    title: "Memory and continuity",
    commands: [
      { name: "memory", usage: "/memory [query]", summary: "Reviewed durable memory. Status, pending proposals, or recall." },
      { name: "cases", usage: "/cases [status|recall [query]]", summary: "Continuity cases: intent → action → outcome → gap." },
      { name: "instincts", usage: "/instincts [status|recall [query]]", summary: "Learned behaviors with confidence. Hints, not instructions." },
    ],
  },
  {
    id: "knowledge",
    title: "Knowledge",
    commands: [
      { name: "qmd", usage: "/qmd", summary: "Localhost catalog of QMD collections, files, search, preview." },
    ],
  },
  {
    id: "research",
    title: "Research",
    commands: [
      { name: "research", usage: "/research [question]", summary: "Bounded parallel research with a cited report and audit." },
      { name: "research-status", usage: "/research-status", summary: "Tracks, evidence, audit, artifact paths." },
      { name: "research-source", usage: "/research-source", summary: "Add a source to the current research run." },
      { name: "research-observation", usage: "/research-observation", summary: "Add a user-verified observation." },
      { name: "research-synthesize", usage: "/research-synthesize", summary: "Rebuild the research report." },
      { name: "research-audit", usage: "/research-audit", summary: "Re-audit cited claims." },
      { name: "research-refresh", usage: "/research-refresh", summary: "Re-fetch sources." },
      { name: "research-export", usage: "/research-export", summary: "Export research artifact paths." },
      { name: "research-handoff", usage: "/research-handoff", summary: "Start a follow-on session from this research run." },
    ],
  },
  {
    id: "council",
    title: "Council",
    commands: [
      { name: "council", usage: "/council [idea]", summary: "Visible council pass, then Intent.md." },
      { name: "council-implement", usage: "/council-implement", summary: "One isolated writer by default after approved intent." },
      { name: "council-force-complete", usage: "/council-force-complete [reason]", summary: "Recorded verification override." },
      { name: "council-decision", usage: "/council-decision [decision]", summary: "Record what the user decided and why." },
      { name: "council-knowledge", usage: "/council-knowledge [query]", summary: "Search QMD-indexed project knowledge." },
      { name: "council-status", usage: "/council-status", summary: "Council state." },
      { name: "council-settings", usage: "/council-settings", summary: "Project-scoped Workbench preferences." },
    ],
  },
  {
    id: "prompt",
    title: "Prompt editing",
    commands: [
      { name: "improve-prompt", usage: "/improve-prompt [draft]", summary: "Clarify wording. Preview only.", aliases: ["improveprompt"] },
      { name: "enhance-prompt", usage: "/enhance-prompt [draft]", summary: "Add labeled context and success criteria. Preview only.", aliases: ["enhance", "reprompt"] },
      { name: "prompt-use", usage: "/prompt-use", summary: "Put the last reviewed draft in the editor without submitting it." },
    ],
  },
  {
    id: "updates",
    title: "Skills and updates",
    commands: [
      { name: "skills-evolve", usage: "/skills-evolve", summary: "Stage trusted skill updates." },
      { name: "skills-evolution-status", usage: "/skills-evolution-status", summary: "Trusted sources and audit." },
      { name: "workbench-update", usage: "/workbench-update [status|apply]", summary: "Inspect or confirm a trusted Workbench update." },
    ],
  },
];

export function listHelpTopics(): string[] {
  const names = new Set<string>();
  for (const group of HELP_GROUPS) {
    names.add(group.id);
    for (const command of group.commands) {
      names.add(command.name);
      for (const alias of command.aliases ?? []) names.add(alias);
    }
  }
  names.add("all");
  names.add("visual");
  names.add("3d");
  return [...names].sort();
}

export function catalogCommandNames(): string[] {
  const names = new Set<string>();
  for (const group of HELP_GROUPS) {
    for (const command of group.commands) {
      names.add(command.name);
      for (const alias of command.aliases ?? []) names.add(alias);
    }
  }
  return [...names];
}

function findCommand(topic: string): { group: HelpGroup; command: HelpCommand } | undefined {
  const needle = topic.toLowerCase();
  for (const group of HELP_GROUPS) {
    for (const command of group.commands) {
      if (command.name === needle || command.aliases?.includes(needle)) return { group, command };
    }
  }
  return undefined;
}

function findGroup(topic: string): HelpGroup | undefined {
  return HELP_GROUPS.find((group) => group.id === topic.toLowerCase());
}

export function formatHelpIndex(): string {
  const lines = [
    "# Pi Workbench",
    "",
    "Coordinator session. Default loop: `/plan` → you approve → `/start-work`.",
    "UI: `/plan-ui`. One command: `/help plan-ui`. Everything discovered: `/help all`.",
    "",
  ];
  for (const group of HELP_GROUPS) {
    lines.push(`## ${group.title}`);
    for (const command of group.commands) {
      lines.push(`- \`${command.usage}\` — ${command.summary}`);
    }
    lines.push("");
  }
  lines.push("Pi builtins such as `/model` and `/settings` live in the slash menu and are not extension commands.");
  return lines.join("\n").trim();
}

export function formatHelpTopic(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  if (normalized === "visual" || normalized === "ui" || normalized === "3d") {
    return `# Visual and 3D

\`/plan-ui <task>\` is a plan-scoped UI loop, not a third workflow mode. Do not use \`/plan --visual\`; that flag opens a prompt box in the slash UI.

- Taste lock at review: direction, hierarchy, interactions, accessibility, constraints, **references**, **refusals**
- Packet must include \`runtime-observation\` and \`artifact-inspection\`
- Verify needs a **host-captured** loopback screenshot (\`captureUrl\` on 127.0.0.1 / localhost). A PNG the child invented cannot complete
- Tests passing is not visual completion
- 3D/WebGL still uses that 2D capture. A pretty still can hide a broken camera, default lights, or missing fallback. Say so; there is no separate \`/plan --3d\` yet

See \`/help plan-ui\`.`;
  }
  const group = findGroup(normalized);
  if (group) {
    const lines = [`# ${group.title}`, ""];
    for (const command of group.commands) {
      lines.push(`## \`/${command.name}\``);
      lines.push(`\`${command.usage}\``);
      lines.push("");
      lines.push(command.details ?? command.summary);
      if (command.aliases?.length) lines.push(`\nAliases: ${command.aliases.map((alias) => `\`/${alias}\``).join(", ")}`);
      lines.push("");
    }
    return lines.join("\n").trim();
  }
  const found = findCommand(normalized);
  if (!found) return `Unknown help topic \`${topic}\`. Try \`/help\`, \`/help plan\`, \`/help visual\`, or \`/help all\`.`;
  const { command } = found;
  const lines = [
    `# \`/${command.name}\``,
    "",
    `\`${command.usage}\``,
    "",
    command.details ?? command.summary,
  ];
  if (command.aliases?.length) lines.push("", `Aliases: ${command.aliases.map((alias) => `\`/${alias}\``).join(", ")}`);
  return lines.join("\n");
}

export function formatDiscoveredCommands(commands: readonly SlashCommandInfo[], sourceFilter?: string): string {
  const allowed = new Set(["extension", "prompt", "skill"]);
  const filter = sourceFilter && allowed.has(sourceFilter) ? sourceFilter : undefined;
  const filtered = filter ? commands.filter((command) => command.source === filter) : [...commands];
  if (filtered.length === 0) return filter ? `No ${filter} commands discovered.` : "No slash commands discovered.";
  const lines = [
    "# Discovered slash commands",
    "",
    "This is what Pi loaded in this session (extensions, then prompts, then skills). Builtins like `/model` are not listed.",
    "",
  ];
  const sources: Array<{ key: SlashCommandInfo["source"]; label: string }> = [
    { key: "extension", label: "Extensions" },
    { key: "prompt", label: "Prompts" },
    { key: "skill", label: "Skills" },
  ];
  for (const { key, label } of sources) {
    const items = filtered.filter((command) => command.source === key);
    if (items.length === 0) continue;
    lines.push(`## ${label}`);
    for (const command of items) {
      const description = command.description?.trim() ? ` — ${command.description.trim()}` : "";
      lines.push(`- \`/${command.name}\`${description}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function formatHelp(topic: string, discovered: readonly SlashCommandInfo[] = []): string {
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return formatHelpIndex();
  if (normalized === "all" || normalized === "commands") return formatDiscoveredCommands(discovered);
  if (normalized === "extension" || normalized === "prompt" || normalized === "skill") {
    return formatDiscoveredCommands(discovered, normalized);
  }
  return formatHelpTopic(topic);
}

export function registerWorkbenchHelp(
  pi: ExtensionAPI,
  report: (title: string, body: string) => void,
): void {
  const handler = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    const topic = rawArgs.trim();
    let discovered: SlashCommandInfo[] = [];
    try { discovered = pi.getCommands(); } catch { discovered = []; }
    report("Workbench help", formatHelp(topic, discovered));
    if (ctx.hasUI && !topic) ctx.ui.setStatus("pi-workbench", "help: /help plan · /help visual · /help all");
  };

  const completions = (prefix: string) => {
    const matches = listHelpTopics().filter((topic) => topic.startsWith(prefix.toLowerCase()));
    return matches.length ? matches.map((value) => ({ value, label: value })) : null;
  };

  for (const name of ["help", "commands", "workbench"] as const) {
    pi.registerCommand(name, {
      description: name === "help"
        ? "How Workbench works and every command: /help [topic|all]"
        : name === "commands"
          ? "List discovered slash commands; same as /help all when given no topic"
          : "Workbench help (alias of /help)",
      getArgumentCompletions: completions,
      handler: name === "commands"
        ? async (args, ctx) => handler(args.trim() || "all", ctx)
        : handler,
    });
  }

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.reason === "reload") return;
    report("Pi Workbench", WORKBENCH_SESSION_BLURB);
  });

  pi.on("before_agent_start", async (event) => {
    if (event.systemPrompt.includes("## Pi Workbench")) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${WORKBENCH_ORIENTATION}` };
  });
}
