import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  getMarkdownTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getAgentById, resolveSupervisorAgents } from "./agents.ts";
import { loadConfig, normalizeConfig, saveConfig } from "./config.ts";
import {
  buildFixTask,
  buildImplementerTask,
  buildLeadTask,
  buildMergeTask,
  buildPlanningTask,
  buildReviewTask,
  buildRoundTask,
  buildSpecialistSystemPrompt,
  buildVerifierTask,
  formatAgentResults,
} from "./prompts.ts";
import {
  appendDecision,
  archiveCurrentState,
  assertCouncilAuthorityUnchanged,
  captureCouncilAuthority,
  CouncilAuthoritySnapshotMismatchError,
  ensureProjectState,
  ensureQmdCollections,
  findProjectRoot,
  formatQmdResults,
  formatSessionSummary,
  getProjectPaths,
  loadSession,
  readOptional,
  refreshQmd,
  saveSession,
  searchQmd,
  writeText,
} from "./project.ts";
import { runAgentsParallel, runSingleAgent } from "./subagents.ts";
import { createCmuxAgentSessionHost } from "./agent-cmux-session.ts";
import { AgentRunManager, setDefaultAgentRunManager } from "./agent-run-manager.ts";
import { registerAgentRuntimeTools } from "./agent-runtime-tools.ts";
import { registerPromptEditor } from "./prompt-editor.ts";
import { captureWorkflowAuthority, getWorkflowPaths } from "./workflow-state.ts";
import { readTaskModelPolicy } from "./task-model-policy.ts";
import { assertMandatoryAgentBatch, assertMandatoryAgentResult } from "./agent-result-guard.ts";
import { acquireExclusiveLease } from "./exclusive-lease.ts";
import { WorkbenchDashboardController } from "./dashboard-controller.ts";
import { registerCmuxWorkbench } from "./cmux-workbench.ts";
import { registerWorkbenchResearch } from "./research.ts";
import { registerWorkflow } from "./workflow.ts";
import { registerSkillEvolution } from "./skill-evolution.ts";
import { registerUserPreferences } from "./user-preferences.ts";
import { registerWorkbenchMemory } from "./memory.ts";
import { registerWorkbenchCases } from "./cases.ts";
import { registerWorkbenchTodo } from "./workbench-todo.ts";
import { registerWorkbenchAsk } from "./workbench-ask.ts";
import { registerWorkbenchGoal } from "./workbench-goal.ts";
import { registerVerificationTool } from "./verification-tool.ts";
import { checkPassed } from "./verification.ts";
import { registerUsageCommand } from "./usage.ts";
import { registerModelRouting } from "./model-routing.ts";
import { registerAutomode } from "./automode.ts";
import { registerWorkbenchUpdate } from "./workbench-update.ts";
import { guardSubagentLaunch } from "./project-trust.ts";
import type { AgentResult, AgentSpec, CouncilSession, Exec } from "./types.ts";
import { canDelegateSpecialists, SupervisorClient, type SupervisorDecision } from "./supervisor.ts";
import {
  assertSafeForParallelWorktrees,
  cleanupWorkerWorkspaces,
  createWorkerWorkspaces,
  describeWorkspaceChanges,
} from "./worktrees.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPROMPTER_SKILL = path.join(EXTENSION_DIR, "reprompter", "SKILL.md");
const REPORT_ENTRY = "pi-workbench-report";
const ISO = () => new Date().toISOString();

interface ReportEntryData {
  title: string;
  body: string;
}

interface LeadSections {
  intent: string;
  decision: string;
  summary: string;
}

function parseLeadSections(output: string): LeadSections {
  const intentMarker = "=== INTENT DOCUMENT ===";
  const decisionMarker = "=== DECISION RECORD ===";
  const summaryMarker = "=== LEAD SUMMARY ===";
  const intentStart = output.indexOf(intentMarker);
  const decisionStart = output.indexOf(decisionMarker);
  const summaryStart = output.indexOf(summaryMarker);
  if (intentStart < 0 || decisionStart <= intentStart || summaryStart <= decisionStart) {
    return {
      intent: `# Intent\n\n> Status: Draft\n\n${output}`,
      decision: "Council lead did not return a parseable decision record. Review the draft before approval.",
      summary: "The lead output was not fully structured; manual review is required.",
    };
  }
  return {
    intent: output.slice(intentStart + intentMarker.length, decisionStart).trim(),
    decision: output.slice(decisionStart + decisionMarker.length, summaryStart).trim(),
    summary: output.slice(summaryStart + summaryMarker.length).trim(),
  };
}

function withIntentStatus(content: string, status: "Draft" | "Approved"): string {
  const withoutOldStatus = content.replace(/^> Status: (?:Draft|Approved)\s*$/m, "").trim();
  return `> Status: ${status}\n> Updated: ${ISO()}\n\n${withoutOldStatus}`;
}

function sessionAllowsImplementation(session: CouncilSession | undefined): session is CouncilSession {
  return Boolean(session && session.phase !== "clarifying");
}

function makeSession(root: string, topic: string, agents: string[]): CouncilSession {
  const now = ISO();
  return {
    version: 1,
    projectRoot: root,
    topic,
    phase: "clarifying",
    createdAt: now,
    updatedAt: now,
    agents,
    rounds: [],
  };
}

function createWorkerSpecs(count: number, roles: string[]): AgentSpec[] {
  const roleSpecs: Record<string, AgentSpec> = {
    developer: {
      id: "developer-implementation",
      title: "Production Implementer",
      description: "Implements the approved behavior using existing project patterns, with deterministic tests.",
      triggers: [],
      readOnly: false,
    },
    qa: {
      id: "qa-implementation",
      title: "Test and Edge-Case Implementer",
      description: "Implements the intent from a test-first perspective, covering regressions, failures, and edge cases.",
      triggers: [],
      readOnly: false,
    },
    security: {
      id: "security-implementation",
      title: "Security and Reliability Implementer",
      description: "Implements a hardened solution focused on trust boundaries, failure handling, and operational safety.",
      triggers: [],
      readOnly: false,
    },
    architect: {
      id: "architect-implementation",
      title: "Simplicity Implementer",
      description: "Implements the smallest maintainable solution while preserving system boundaries and architecture.",
      triggers: [],
      readOnly: false,
    },
  };
  const specs = roles.map((role) => roleSpecs[role]).filter((spec): spec is AgentSpec => Boolean(spec));
  if (specs.length === 0) throw new Error("Supervisor selected no valid implementation worker specialties.");
  return specs.slice(0, Math.max(1, Math.min(count, specs.length)));
}

function report(pi: ExtensionAPI, title: string, body: string): void {
  pi.appendEntry(REPORT_ENTRY, { title, body } satisfies ReportEntryData);
}

function makeProgress(ctx: any, title: string): { update: (message: string) => void; clear: () => void } {
  return {
    update(message: string) {
      if (ctx.hasUI) ctx.ui.setStatus("pi-workbench", `${title}: ${message}`);
    },
    clear() {
      if (ctx.hasUI) ctx.ui.setStatus("pi-workbench", undefined);
    },
  };
}

function announce(pi: ExtensionAPI, ctx: any, title: string, body: string): void {
  report(pi, title, body);
  if (ctx.hasUI) ctx.ui.setStatus("pi-workbench", `${title}: ${body.replace(/\s+/g, " ").trim().slice(0, 96)}`);
}

function formatLeaderDecision(decision: SupervisorDecision): string {
  const roles = decision.roles.length ? decision.roles.join(", ") : "(none)";
  return `**${decision.action}** — ${decision.phase}\n\n${decision.rationale}\n\nRoles: ${roles}${decision.question ? `\n\nQuestion: ${decision.question}` : ""}`;
}

function isVerified(output: string): boolean {
  return /<verified\s*\/>/.test(output) && !/<failed\s*\/>/.test(output);
}

function reviewsRequireChanges(results: AgentResult[]): boolean {
  return results.some((result) => result.exitCode !== 0 || /CHANGES_REQUIRED|BLOCKED/i.test(result.output));
}

async function recordSupervisorDecision(paths: ReturnType<typeof getProjectPaths>, decision: SupervisorDecision): Promise<void> {
  await appendDecision(
    paths,
    `## Supervisor recommendation — ${ISO()}\n\n**Phase:** ${decision.phase}\n\n**Action:** ${decision.action}\n\n**Roles:** ${decision.roles.join(", ") || "(none)"}\n\n**Rationale:** ${decision.rationale}${decision.question ? `\n\n**Question:** ${decision.question}` : ""}`,
  );
}

async function requestSupervisorDecision(
  pi: ExtensionAPI,
  supervisor: SupervisorClient,
  ctx: any,
  paths: ReturnType<typeof getProjectPaths>,
  prompt: string,
): Promise<SupervisorDecision> {
  let decision = await supervisor.decide(prompt);
  for (let attempt = 0; attempt < 5; attempt++) {
    await recordSupervisorDecision(paths, decision);
    if (decision.action !== "ask_user") return decision;
    announce(pi, ctx, "Council leader", formatLeaderDecision(decision));
    const answer = await ctx.ui.editor(
      `Supervisor question — ${decision.phase}`,
      decision.question ?? decision.rationale,
    );
    if (answer === undefined) throw new Error("Supervisor question was cancelled by the user.");
    await appendDecision(paths, `## User answer to Supervisor — ${ISO()}\n\n${answer.trim() || "(No answer provided.)"}`);
    decision = await supervisor.decide(`${prompt}\n\nUSER ANSWER:\n${answer.trim() || "(No answer provided.)"}`);
  }
  throw new Error("Supervisor asked too many consecutive questions without producing a decision.");
}

function implementationWorkerTask(
  spec: AgentSpec,
  topic: string,
  intent: string,
  decisions: string,
  plan: string,
): string {
  return `You are one of several parallel implementation workers in an isolated Git worktree. Your specialty is ${spec.description}

TOPIC:\n${topic}

APPROVED INTENT:\n${intent}

DECISIONS:\n${decisions}

SPECIALIST PLAN:\n${plan}

Implement a complete candidate solution in this worktree. You own this isolated copy, so make real file changes. Do not commit. Add or update deterministic tests. Run the canonical relevant tests and fix failures. Your work will be inspected and selectively integrated by a separate merger.

Return:
## Candidate Changes
## Files Changed
## Tests Run
## Test Evidence
## Trade-offs
## Integration Notes
`;
}

export default function piWorkbench(pi: ExtensionAPI) {
  registerCmuxWorkbench(pi);
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);
  const dashboard = new WorkbenchDashboardController(pi);
  const agentRunManager = new AgentRunManager({ dashboard, sessionHost: createCmuxAgentSessionHost() });
  setDefaultAgentRunManager(agentRunManager);
  const modelRouting = registerModelRouting(pi, (title, body) => report(pi, title, body));
  registerAgentRuntimeTools(pi, {
    manager: agentRunManager,
    exec,
    getRoutingState: () => modelRouting.getState(),
  });

  registerUserPreferences(pi);
  registerWorkbenchMemory(pi, {
    exec,
    report: (title, body) => report(pi, title, body),
  });
  registerWorkbenchCases(pi, {
    exec,
    report: (title, body) => report(pi, title, body),
  });
  registerWorkbenchTodo(pi, (title, body) => report(pi, title, body));
  registerWorkbenchAsk(pi);
  registerVerificationTool(pi);
  registerWorkbenchGoal(pi, {
    exec,
    report: (title, body) => report(pi, title, body),
  });
  registerSkillEvolution(pi);
  registerUsageCommand(pi, (title, body) => report(pi, title, body));
  registerWorkbenchUpdate(pi, { root: EXTENSION_DIR, exec });

  pi.registerEntryRenderer(REPORT_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data as ReportEntryData;
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(`⚒ ${data.title}`)), 0, 0));
    container.addChild(new Spacer(1));
    const body = expanded ? data.body : data.body.split("\n").slice(0, 60).join("\n");
    container.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
    if (!expanded && data.body.split("\n").length > 60) {
      container.addChild(new Text(theme.fg("muted", "(expand tool output to see the full report)"), 0, 0));
    }
    return container;
  });

  pi.on("session_start", async (_event, ctx) => {
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? `:${ctx.thinkingLevel}` : ""}` : undefined;
    agentRunManager.setDefaultModel(parentModel);
    const root = await findProjectRoot(ctx.cwd, exec);
    const session = await loadSession(getProjectPaths(root));
    if (session && ctx.hasUI) ctx.ui.setStatus("pi-workbench", `council: ${session.phase}`);
    dashboard.attach(ctx);
    await agentRunManager.recover(root);
  });

  pi.on("session_shutdown", async () => {
    dashboard.dispose();
    await agentRunManager.shutdown();
  });

  pi.registerShortcut("ctrl+alt+a", {
    description: "Toggle Sreeram's Pi Workbench agent dashboard",
    handler: () => dashboard.toggleFocus(),
  });

  pi.registerCommand("council", {
    description: "Interrogate an idea with a dynamic council and produce an approved project Intent.md",
    handler: async (rawArgs, ctx) => {
      const trustRequired = guardSubagentLaunch(ctx);
      if (trustRequired) {
        report(pi, "Project trust required", trustRequired);
        return;
      }
      if (!ctx.hasUI) {
        report(pi, "Council unavailable", "`/council` requires interactive UI for user checkpoints.");
        return;
      }

      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      await ensureProjectState(paths);
      const config = await loadConfig(paths);
      const existing = await loadSession(paths);
      const explicitTopic = rawArgs.trim();
      let startingNewCouncil = !existing;

      let topic = explicitTopic;
      if (!topic && existing) {
        const changed = await ctx.ui.editor(
          "Resume Sreeram's Pi Workbench",
          `Existing topic: ${existing.topic}\n\nWhat changed, what did you learn, or what should the council reconsider?`,
        );
        if (changed === undefined) return;
        topic = changed.trim() ? `${existing.topic}\n\nNew user context:\n${changed.trim()}` : existing.topic;
      } else if (!topic) {
        const entered = await ctx.ui.editor("Start Sreeram's Pi Workbench", "Describe the idea, problem, or project in your own words.");
        if (!entered?.trim()) return;
        topic = entered.trim();
      }

      if (existing && explicitTopic && explicitTopic !== existing.topic) {
        const action = await ctx.ui.select("A council already exists for this project", [
          "Start a new council and archive the current intent",
          "Treat this as additional context for the current council",
          "Cancel",
        ]);
        if (!action || action === "Cancel") return;
        if (action.startsWith("Start")) {
          await archiveCurrentState(paths);
          startingNewCouncil = true;
        } else {
          topic = `${existing.topic}\n\nNew user context:\n${explicitTopic}`;
        }
      }

      const retainedAgents = existing && !startingNewCouncil
        ? existing.agents.map((id) => getAgentById(id)).filter((agent): agent is AgentSpec => Boolean(agent))
        : [];
      let agents = retainedAgents;
      let session: CouncilSession | undefined;
      ctx.ui.setStatus("pi-workbench", "council: clarifying");

      dashboard.beginRun(`council-${Date.now()}`);
      const supervisor = new SupervisorClient(root, dashboard, agentRunManager);
      const progress = makeProgress(ctx, "Sreeram's Pi Workbench — clarification");
      try {
        await supervisor.start();
        if (config.qmdEnabled) {
          progress.update("registering project knowledge with QMD");
          await ensureQmdCollections(paths, exec);
          await refreshQmd(exec);
        }

        const intentBefore = await readOptional(paths.intent);
        const decisionsBefore = await readOptional(paths.decisions);
        const qmdResults = config.qmdEnabled ? await searchQmd(paths, exec, topic) : [];
        const qmdContext = formatQmdResults(qmdResults);
        announce(pi, ctx, "Council leader", "Choosing specialists for this topic. Watch the Supervisor tab, or press Ctrl+Alt+A.");
        const initialDecision = await requestSupervisorDecision(
          pi,
          supervisor,
          ctx,
          paths,
          `Start a council for this topic. Choose the smallest relevant specialist set for clarification.\n\nTOPIC:\n${topic}\n\nPROJECT KNOWLEDGE:\n${qmdContext}`,
        );
        announce(pi, ctx, "Council leader", formatLeaderDecision(initialDecision));
        if (!canDelegateSpecialists(initialDecision)) throw new Error(`Supervisor did not authorize council delegation: ${initialDecision.action}`);
        agents = resolveSupervisorAgents(initialDecision, config.maxCouncilAgents);
        session = makeSession(root, topic, agents.map((agent) => agent.id));
        await saveSession(paths, session);
        let transcript = "";
        let checkpoint = "";

        for (let round = 1; round <= 3; round++) {
          const roster = agents.map((agent) => agent.title).join(", ");
          announce(pi, ctx, "Council", `Opening ${agents.length} interactive specialist tab${agents.length === 1 ? "" : "s"}: ${roster}. Chat in those tabs or press Ctrl+Alt+A.`);
          progress.update(`round ${round}: ${roster}`);
          const results = await runAgentsParallel(
            root,
            agents,
            (agent) => buildSpecialistSystemPrompt(agent, REPROMPTER_SKILL, false),
            () => buildRoundTask(round, topic, intentBefore, decisionsBefore, qmdContext, transcript, checkpoint),
            undefined,
            progress.update,
            { dashboard, groupId: `round-${round}`, groupTitle: `Round ${round}` },
          );
          assertMandatoryAgentBatch(results, `council round ${round}`);
          const roundText = formatAgentResults(results);
          transcript += `\n\n# Round ${round}\n\n${roundText}`;
          if (!session) throw new Error("Council session was not initialized");
          session.rounds.push({ number: round, completedAt: ISO(), checkpoint: round === 1 ? checkpoint : undefined });
          session.updatedAt = ISO();
          await saveSession(paths, session);
          report(pi, `Council Round ${round}`, roundText);

          announce(pi, ctx, "Council leader", "Reading the round and deciding whether to synthesize or continue.");
          const nextDecision = await requestSupervisorDecision(
            pi,
            supervisor,
            ctx,
            paths,
            `Round ${round} completed. Re-plan the next council step. Prefer synthesize after one useful pass unless a material gap remains.\n\nTOPIC:\n${topic}\n\nROUND REPORT:\n${roundText}`,
          );
          announce(pi, ctx, "Council leader", formatLeaderDecision(nextDecision));
          if (round < 3 && nextDecision.roles.length > 0 && nextDecision.action === "delegate") {
            agents = resolveSupervisorAgents(nextDecision, config.maxCouncilAgents);
          }

          if (round === 1) {
            const input = await ctx.ui.editor(
              "Council checkpoint",
              nextDecision.question ?? "Leave empty to synthesize Intent.md now. Write more only if the council should run another pass.",
            );
            checkpoint = input?.trim() ?? "";
            session.rounds[0].checkpoint = checkpoint;
            await appendDecision(
              paths,
              `## User checkpoint — ${ISO()}\n\n**Topic:** ${topic}\n\n**User input:**\n${checkpoint || "(No additional context; synthesize now.)"}`,
            );
            if (!checkpoint || /skip to synthesis/i.test(checkpoint)) break;
          }
          if (nextDecision.action === "synthesize" || nextDecision.action === "complete") break;
        }

        const synthesisDecision = await requestSupervisorDecision(
          pi,
          supervisor,
          ctx,
          paths,
          `The council has completed clarification. Decide whether the next step is synthesis and identify any unresolved user question.\n\nTRANSCRIPT:\n${transcript}`,
        );
        announce(pi, ctx, "Council leader", "Synthesizing Intent.md from the council pass. Watch the Lead synthesis tab.");
        progress.update("lead synthesizing intent and decision record");
        const lead: AgentSpec = {
          id: "lead",
          title: "Council Lead",
          description: "Synthesizes disagreement into an explicit, user-owned intent contract.",
          triggers: [],
          readOnly: true,
        };
        const leadResult = await runSingleAgent(
          root,
          lead,
          buildSpecialistSystemPrompt(lead, REPROMPTER_SKILL, false),
          buildLeadTask(topic, transcript, await readOptional(paths.decisions), qmdContext),
          undefined,
          progress.update,
          { dashboard, groupId: "lead-synthesis", groupTitle: "Lead synthesis", jobId: "lead-synthesis" },
        );
        assertMandatoryAgentResult(leadResult, "council synthesis");
        const sections = parseLeadSections(leadResult.output);
        const edited = await ctx.ui.editor("Review and edit Intent.md", withIntentStatus(sections.intent, "Draft"));
        if (edited === undefined) {
          await writeText(paths.intent, withIntentStatus(sections.intent, "Draft"));
          await appendDecision(paths, `## Council synthesis — ${ISO()}\n\n${sections.decision}\n\n**User approval:** not given; intent remains Draft.`);
          report(pi, "Council synthesis", `${sections.summary}\n\nIntent saved as a draft at ${paths.intent}.`);
          return;
        }

        const approved = await ctx.ui.confirm(
          "Use this Intent.md?",
          "Confirming records the decision in session.json. Intent.md stays the page to read; a Status line in the markdown is not a runtime gate. You can run /council again to revise it.",
        );
        await writeText(paths.intent, withIntentStatus(edited, approved ? "Approved" : "Draft"));
        await appendDecision(
          paths,
          `## Council synthesis — ${ISO()}\n\n${sections.decision}\n\n**User approval:** ${approved ? "Approved the edited Intent.md." : "Not approved; intent remains Draft."}`,
        );
        if (!session) throw new Error("Council session was not initialized");
        session.phase = approved ? "intent-approved" : "clarifying";
        session.updatedAt = ISO();
        await saveSession(paths, session);
        if (config.qmdEnabled) await refreshQmd(exec);
        ctx.ui.setStatus("pi-workbench", `council: ${session.phase}`);
        report(
          pi,
          approved ? "Intent approved" : "Intent remains draft",
          `${sections.summary}\n\n- Intent: ${paths.intent}\n- Decisions: ${paths.decisions}\n- QMD: ${config.qmdEnabled ? "indexed" : "disabled"}`,
        );
      } finally {
        await supervisor.dispose();
        progress.clear();
        dashboard.endRun();
      }
    },
  });

  pi.registerCommand("council-implement", {
    description: "Implement a TUI-confirmed intent with one isolated writer by default, then reviews and a test gate",
    handler: async (rawArgs, ctx) => {
      const trustRequired = guardSubagentLaunch(ctx);
      if (trustRequired) {
        report(pi, "Project trust required", trustRequired);
        return;
      }
      if (!ctx.hasUI) {
        report(pi, "Implementation unavailable", "`/council-implement` requires interactive UI.");
        return;
      }
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      const authority = await captureCouncilAuthority(paths);
      const session = authority.session;
      const config = await loadConfig(paths);
      const intent = authority.intent;
      if (!sessionAllowsImplementation(session)) {
        report(pi, "Intent not confirmed", "Run `/council <idea>` and confirm Intent.md in the TUI before implementation. A Status line in the markdown is not enough.");
        return;
      }

      const requestedMode = rawArgs.trim().toLowerCase();
      const startedInNewSession = requestedMode === "same-from-new";
      let mode: "same" | "new" | "" = startedInNewSession
        ? "same"
        : requestedMode === "same" || requestedMode === "new"
          ? requestedMode
          : "";
      if (!mode && config.defaultImplementationSession !== "ask") mode = config.defaultImplementationSession;
      if (!mode) {
        const choice = await ctx.ui.select("Where should implementation run?", [
          "New session (recommended)",
          "This session",
          "Cancel",
        ]);
        if (!choice || choice === "Cancel") return;
        mode = choice.startsWith("New") ? "new" : "same";
      }
      if (mode === "new") {
        try {
          await assertCouncilAuthorityUnchanged(paths, authority);
        } catch (error) {
          if (!(error instanceof CouncilAuthoritySnapshotMismatchError)) throw error;
          report(pi, "Council state changed", error.message);
          return;
        }
        await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile(),
          withSession: async (fresh) => {
            await fresh.sendUserMessage("/council-implement same-from-new");
          },
        });
        return;
      }

      try {
        await assertSafeForParallelWorktrees(root, exec);
      } catch (error) {
        report(pi, "Parallel implementation blocked", error instanceof Error ? error.message : String(error));
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Begin opinionated implementation?",
        `This desk will run ${config.parallelImplementationWorkers} isolated implementation worker${config.parallelImplementationWorkers === 1 ? "" : "s"} (default is one), then review and a test gate, for up to ${config.maxFixLoops} fix loops. Parallel workers are opt-in. Model text is not a host receipt.`,
      );
      if (!confirmed) return;

      let writerLease: Awaited<ReturnType<typeof acquireExclusiveLease>>;
      try {
        writerLease = await acquireExclusiveLease(root, "council-implement");
      } catch (error) {
        report(pi, "Council writer unavailable", error instanceof Error ? error.message : String(error));
        return;
      }
      try {
        await assertCouncilAuthorityUnchanged(paths, authority);
      } catch (error) {
        await writerLease.release();
        if (!(error instanceof CouncilAuthoritySnapshotMismatchError)) throw error;
        report(pi, "Council state changed", error.message);
        return;
      }
      dashboard.beginRun(`implementation-${Date.now()}`);
      const supervisor = new SupervisorClient(root, dashboard, agentRunManager);
      const progress = makeProgress(ctx, "Sreeram's Pi Workbench — implementation");
      let workspaceGroup: Awaited<ReturnType<typeof createWorkerWorkspaces>> | undefined;
      try {
        await supervisor.start();
        session.phase = "implementing";
        session.updatedAt = ISO();
        const implementationSessionMode = startedInNewSession ? "new" : "same";
        session.implementation = { startedAt: ISO(), sessionMode: implementationSessionMode };
        await saveSession(paths, session);
        ctx.ui.setStatus("pi-workbench", "council: implementing");

        if (config.qmdEnabled) {
          await ensureQmdCollections(paths, exec);
          await refreshQmd(exec);
        }
        const decisions = await readOptional(paths.decisions);
        const qmdContext = formatQmdResults(config.qmdEnabled ? await searchQmd(paths, exec, `${session.topic} implementation`) : []);

        const planningDecision = await requestSupervisorDecision(
          pi,
          supervisor,
          ctx,
          paths,
          `Choose the relevant implementation-planning specialists for this approved intent. Do not include UX unless the changed surface is user-facing.\n\nTOPIC:\n${session.topic}\n\nINTENT:\n${intent}\n\nDECISIONS:\n${decisions}`,
        );
        if (!canDelegateSpecialists(planningDecision)) throw new Error(`Supervisor did not authorize implementation planning: ${planningDecision.action}`);
        const planningAgents = resolveSupervisorAgents(planningDecision, config.maxCouncilAgents);
        progress.update(`${planningAgents.length} specialists preparing implementation briefs in parallel`);
        const planningResults = await runAgentsParallel(
          root,
          planningAgents,
          (agent) => buildSpecialistSystemPrompt(agent, REPROMPTER_SKILL, false),
          (agent) => buildPlanningTask(agent, session.topic, intent, decisions, qmdContext),
          undefined,
          progress.update,
          { dashboard, groupId: "implementation-planning", groupTitle: "Implementation planning" },
        );
        assertMandatoryAgentBatch(planningResults, "council implementation planning");
        const plan = formatAgentResults(planningResults);
        await writeText(paths.implementationPlan, `# Implementation Plan\n\n${plan}`);
        report(pi, "Parallel implementation briefs", plan);

        const workerDecision = await requestSupervisorDecision(
          pi,
          supervisor,
          ctx,
          paths,
          `Choose the number and specialties of independent implementation candidates and confirm delegation for this approved intent. Use roles such as developer, qa, security, and architect.\n\nPLAN:\n${plan}`,
        );
        if (workerDecision.action !== "delegate") throw new Error(`Supervisor did not authorize implementation delegation: ${workerDecision.action}`);
        const workerSpecs = createWorkerSpecs(workerDecision.workerCount ?? config.parallelImplementationWorkers, workerDecision.roles);
        progress.update(`creating ${workerSpecs.length} isolated Git worktrees`);
        workspaceGroup = await createWorkerWorkspaces(root, workerSpecs.map((worker) => worker.title), exec);

        progress.update(`${workerSpecs.length} implementation candidates running in parallel`);
        const workerResults = await Promise.all(
          workspaceGroup.workers.map((workspace, index) => {
            const spec = workerSpecs[index];
            return runSingleAgent(
              workspace.path,
              spec,
              buildSpecialistSystemPrompt(spec, REPROMPTER_SKILL, true),
              implementationWorkerTask(spec, session.topic, intent, decisions, plan),
              undefined,
              progress.update,
              {
                dashboard,
                groupId: "implementation-candidates",
                groupTitle: "Implementation candidates",
                jobId: `candidate-${spec.id}`,
                memoryProjectRoot: root,
              },
            );
          }),
        );
        assertMandatoryAgentBatch(workerResults, "council implementation candidates");
        const workerReports = formatAgentResults(workerResults);
        const manifests = (
          await Promise.all(workspaceGroup.workers.map((worker) => describeWorkspaceChanges(worker, exec)))
        ).join("\n\n---\n\n");
        report(pi, "Parallel implementation candidates", workerReports);

        progress.update("integration implementer reconciling candidates into the main tree");
        const merger: AgentSpec = {
          id: "integration-implementer",
          title: "Integration Implementer",
          description: "Integrates parallel candidate work into one coherent, tested implementation.",
          triggers: [],
          readOnly: false,
        };
        let implementation = await runSingleAgent(
          root,
          merger,
          buildSpecialistSystemPrompt(merger, REPROMPTER_SKILL, true),
          buildMergeTask(session.topic, intent, decisions, plan, workerReports, manifests),
          undefined,
          progress.update,
          { dashboard, groupId: "integration", groupTitle: "Integration", jobId: "integration-implementer" },
        );
        assertMandatoryAgentResult(implementation, "council integration");
        report(pi, "Integrated implementation", implementation.output);

        await cleanupWorkerWorkspaces(root, workspaceGroup, exec);
        workspaceGroup = undefined;

        const reviewerDecision = await requestSupervisorDecision(
          pi,
          supervisor,
          ctx,
          paths,
          `Choose reviewers for the integrated implementation. Inspect the intent, worker reports, and changed-file manifest. Include UX only if there is a user-facing UI impact.\n\nINTENT:\n${intent}\n\nWORKER REPORTS:\n${workerReports}\n\nCHANGES:\n${manifests}`,
        );
        if (reviewerDecision.action !== "review") throw new Error(`Supervisor did not authorize review: ${reviewerDecision.action}`);
        const reviewers = resolveSupervisorAgents(reviewerDecision, config.maxCouncilAgents);
        const verifier: AgentSpec = {
          id: "verifier",
          title: "Independent Test Verifier",
          description: "Independently runs the canonical verification commands and rejects untested completion.",
          triggers: [],
          readOnly: true,
          allowBash: true,
        };
        const fixer: AgentSpec = {
          id: "fixer",
          title: "Verification Fixer",
          description: "Fixes review and test failures without weakening the approved intent or tests.",
          triggers: [],
          readOnly: false,
        };

        let finalVerification = "";
        for (let attempt = 0; attempt <= config.maxFixLoops; attempt++) {
          progress.update(`review cycle ${attempt + 1}: reviewers running in parallel`);
          const reviews = await runAgentsParallel(
            root,
            reviewers,
            (agent) => buildSpecialistSystemPrompt(agent, REPROMPTER_SKILL, false),
            (agent) => buildReviewTask(agent, session.topic, intent, implementation.output),
            undefined,
            progress.update,
            { dashboard, groupId: `review-${attempt + 1}`, groupTitle: `Review cycle ${attempt + 1}` },
          );
          assertMandatoryAgentBatch(reviews, `council review cycle ${attempt + 1}`);
          const reviewText = formatAgentResults(reviews);
          report(pi, `Parallel code review — cycle ${attempt + 1}`, reviewText);

          progress.update(`verification cycle ${attempt + 1}: running real tests`);
          const verification = await runSingleAgent(
            root,
            verifier,
            buildSpecialistSystemPrompt(verifier, REPROMPTER_SKILL, false),
            buildVerifierTask(session.topic, intent, implementation.output),
            undefined,
            progress.update,
            { dashboard, groupId: `verification-${attempt + 1}`, groupTitle: `Verification cycle ${attempt + 1}`, jobId: `verifier-${attempt + 1}` },
          );
          assertMandatoryAgentResult(verification, `council verification cycle ${attempt + 1}`);
          finalVerification = verification.output;
          report(pi, `Independent verification — cycle ${attempt + 1}`, verification.output);

          const outcomeDecision = await requestSupervisorDecision(
            pi,
            supervisor,
            ctx,
            paths,
            `Review cycle ${attempt + 1} is complete. Decide whether to complete, fix, or run another targeted review. The independent test gate is authoritative.\n\nREVIEWS:\n${reviewText}\n\nVERIFICATION:\n${verification.output}`,
          );

          const observedChecks = verification.verification;
          const checksPassed = observedChecks && observedChecks.receipts.length > 0
            && observedChecks.receipts.every((receipt) => checkPassed(receipt, observedChecks.snapshot));
          if (isVerified(verification.output) && checksPassed && !reviewsRequireChanges(reviews) && outcomeDecision.action === "complete") {
            session.phase = "verified";
            session.updatedAt = ISO();
            session.implementation = {
              ...(session.implementation ?? { startedAt: ISO(), sessionMode: "same" }),
              lastVerification: { passed: true, output: verification.output, completedAt: ISO() },
            };
            await saveSession(paths, session);
            await appendDecision(
              paths,
              `## Implementation verified — ${ISO()}\n\nThe independent verification gate passed after cycle ${attempt + 1}.\n\n${verification.output}`,
            );
            if (config.qmdEnabled) await refreshQmd(exec);
            ctx.ui.setStatus("pi-workbench", "council: verified");
            report(pi, "Implementation verified", `The approved intent is implemented and independently tested.\n\n${verification.output}`);
            return;
          }

          if (attempt >= config.maxFixLoops) break;
          if (outcomeDecision.action !== "fix") {
            throw new Error(`Supervisor stopped before verification passed: ${outcomeDecision.action}`);
          }
          progress.update(`fix cycle ${attempt + 1}: addressing review and test failures`);
          implementation = await runSingleAgent(
            root,
            fixer,
            buildSpecialistSystemPrompt(fixer, REPROMPTER_SKILL, true),
            buildFixTask(session.topic, intent, implementation.output, reviewText, verification.output),
            undefined,
            progress.update,
            { dashboard, groupId: `fix-${attempt + 1}`, groupTitle: `Fix cycle ${attempt + 1}`, jobId: `fixer-${attempt + 1}` },
          );
          assertMandatoryAgentResult(implementation, `council fix cycle ${attempt + 1}`);
          report(pi, `Fix cycle ${attempt + 1}`, implementation.output);
        }

        session.phase = "implementing";
        session.updatedAt = ISO();
        session.implementation = {
          ...(session.implementation ?? { startedAt: ISO(), sessionMode: "same" }),
          lastVerification: { passed: false, output: finalVerification, completedAt: ISO() },
        };
        await saveSession(paths, session);
        await appendDecision(
          paths,
          `## Implementation verification blocked — ${ISO()}\n\nPi Workbench exhausted ${config.maxFixLoops} fix loops without a trustworthy passing test result. The project is not marked complete.\n\n${finalVerification}`,
        );
        report(
          pi,
          "Implementation is not complete",
          `Tests or reviews still fail after ${config.maxFixLoops} fix loops. The council refuses to call this complete. Fix the blockers and rerun \`/council-implement same\`, or explicitly use \`/council-force-complete <reason>\` to override.\n\n${finalVerification}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.phase = "implementing";
        session.updatedAt = ISO();
        try {
          await saveSession(paths, session);
          await appendDecision(
            paths,
            `## Implementation interrupted — ${ISO()}\n\nPi Workbench stopped before verified completion.\n\n**Error:** ${message}`,
          );
        } catch {
          // Preserve the original failure in the visible report.
        }
        report(pi, "Implementation interrupted", `${message}\n\nThe project is not marked complete.`);
      } finally {
        if (workspaceGroup) await cleanupWorkerWorkspaces(root, workspaceGroup, exec);
        await supervisor.dispose();
        await writerLease.release();
        progress.clear();
        dashboard.endRun();
      }
    },
  });

  pi.registerCommand("council-force-complete", {
    description: "Explicitly override failed/missing verification with a recorded rationale",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) return;
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      const authority = await captureCouncilAuthority(paths);
      const session = authority.session;
      if (!session) {
        report(pi, "No council", "Run `/council` first.");
        return;
      }
      let reason = rawArgs.trim();
      if (!reason) {
        reason = (await ctx.ui.editor(
          "Force completion rationale",
          "Explain why you are overriding the test gate and accepting the risk.",
        ))?.trim() ?? "";
      }
      if (!reason) return;
      const confirmed = await ctx.ui.confirm(
        "Override failed verification?",
        "This will be permanently recorded as a user override. It does not make failing tests pass.",
      );
      if (!confirmed) return;
      try {
        await assertCouncilAuthorityUnchanged(paths, authority);
      } catch (error) {
        if (!(error instanceof CouncilAuthoritySnapshotMismatchError)) throw error;
        report(pi, "Council state changed", error.message);
        return;
      }
      session.phase = "force-completed";
      session.updatedAt = ISO();
      await saveSession(paths, session);
      await appendDecision(
        paths,
        `## User forced completion — ${ISO()}\n\n**Rationale:** ${reason}\n\n**Consequence:** The user explicitly accepted incomplete or failing verification. This is not a tested completion.`,
      );
      ctx.ui.setStatus("pi-workbench", "council: force-completed");
      report(pi, "Completion forced by user", `Reason: ${reason}\n\nThe decision was recorded in ${paths.decisions}.`);
    },
  });

  pi.registerCommand("council-decision", {
    description: "Record a project decision and why the user made it",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) return;
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      await ensureProjectState(paths);
      let decision = rawArgs.trim();
      if (!decision) decision = (await ctx.ui.editor("Decision", "What did you decide?"))?.trim() ?? "";
      if (!decision) return;
      const rationale = (await ctx.ui.editor("Rationale", "Why did you make this decision? What alternatives did you reject?"))?.trim();
      if (rationale === undefined) return;
      await appendDecision(
        paths,
        `## User decision — ${ISO()}\n\n**Decision:** ${decision}\n\n**Rationale:** ${rationale || "Not provided."}`,
      );
      const config = await loadConfig(paths);
      if (config.qmdEnabled) {
        await ensureQmdCollections(paths, exec);
        await refreshQmd(exec);
      }
      report(pi, "Decision recorded", `**Decision:** ${decision}\n\n**Rationale:** ${rationale || "Not provided."}`);
    },
  });

  pi.registerCommand("council-knowledge", {
    description: "Search this project's QMD-indexed knowledge and council decisions",
    handler: async (rawArgs, ctx) => {
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      const config = await loadConfig(paths);
      let query = rawArgs.trim();
      if (!query && ctx.hasUI) query = (await ctx.ui.input("Search project knowledge", "decision, requirement, architecture..."))?.trim() ?? "";
      if (!query) return;
      if (!config.qmdEnabled) {
        report(pi, "QMD disabled", "Enable QMD with `/council-settings`.");
        return;
      }
      await ensureQmdCollections(paths, exec);
      await refreshQmd(exec);
      const results = await searchQmd(paths, exec, query, 12);
      report(pi, `Knowledge: ${query}`, formatQmdResults(results));
    },
  });

  pi.registerCommand("council-status", {
    description: "Show Sreeram's Pi Workbench state and document paths for the current project",
    handler: async (_args, ctx) => {
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      const session = await loadSession(paths);
      report(
        pi,
        "Sreeram's Pi Workbench status",
        `${formatSessionSummary(session)}\n\n- Intent: ${paths.intent}\n- Decisions: ${paths.decisions}\n- Plan: ${paths.implementationPlan}\n- Settings: ${path.join(paths.stateDir, "config.json")}`,
      );
    },
  });

  pi.registerCommand("council-settings", {
    description: "Edit project-scoped preferences for Sreeram's Pi Workbench",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      await ensureProjectState(paths);
      const current = await loadConfig(paths);
      const edited = await ctx.ui.editor("Sreeram's Pi Workbench project settings", JSON.stringify(current, null, 2));
      if (edited === undefined) return;
      try {
        const config = normalizeConfig(JSON.parse(edited));
        await saveConfig(paths, config);
        report(pi, "Settings saved", `\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\``);
      } catch (error) {
        ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  registerWorkbenchResearch(pi, {
    exec,
    dashboard,
    report: (title, body) => report(pi, title, body),
  });

  registerAutomode(pi, (title, body) => report(pi, title, body));

  registerWorkflow(pi, {
    exec,
    dashboard,
    reprompterPath: REPROMPTER_SKILL,
    report: (title, body) => report(pi, title, body),
    getRoutingState: () => modelRouting.getState(),
  });

  registerPromptEditor(pi, {
    report: (title, body) => report(pi, title, body),
    async context(ctx) {
      if (guardSubagentLaunch(ctx)) return "Project context was not loaded because the project trust decision does not permit it. Improve the supplied text only.";
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getWorkflowPaths(getProjectPaths(root).stateDir);
      const state = (await captureWorkflowAuthority(paths)).state;
      const policy = state ? await readTaskModelPolicy(paths, state) : null;
      return JSON.stringify({ projectRoot: root,
        recordedWorkflow: state ? { id: state.id, task: state.task, status: state.status, designBrief: state.designBrief, modelPolicy: policy } : null,
        provenance: "Recorded workflow context, not fresh source inspection. Use it only when relevant to this request. A draft rewrite cannot change approved scope or model preferences.",
      });
    },
  });

  pi.registerTool({
    name: "council_knowledge",
    label: "Council Knowledge",
    description: "Search the current project's QMD-indexed Markdown, approved intent, and decision history.",
    promptSnippet: "Search project intent, decisions, and Markdown knowledge through QMD",
    promptGuidelines: [
      "Use council_knowledge when prior project decisions or approved intent could change the answer; do not invent project history.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Focused search query" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = await findProjectRoot(ctx.cwd, exec);
      const paths = getProjectPaths(root);
      const config = await loadConfig(paths);
      if (!config.qmdEnabled) {
        return { content: [{ type: "text", text: "QMD is disabled for this project." }], details: { results: [] } };
      }
      await ensureProjectState(paths);
      await ensureQmdCollections(paths, exec);
      const results = await searchQmd(paths, exec, params.query, params.limit ?? 8);
      return {
        content: [{ type: "text", text: formatQmdResults(results) }],
        details: { results },
      };
    },
  });
}
