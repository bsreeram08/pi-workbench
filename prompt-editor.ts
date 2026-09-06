import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { buildPromptEnhancementInstructions } from "./prompt-discipline.ts";
import { startWorkflowActivity } from "./workflow-activity.ts";
import { throwIfWorkflowCancelled } from "./agent-result-guard.ts";

interface Dependencies {
  context?(ctx: ExtensionContext): Promise<string>;
  report(title: string, body: string): void;
}
interface PromptRequest {
  requestId: string;
  original: string;
  mode: "improve" | "enhance";
  cwd: string;
  editorBefore: string;
  improved?: string;
  changes?: string[];
  assumptions?: string[];
  questions?: string[];
}
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function publicRequest(request: PromptRequest) {
  const { editorBefore: _privateEditorBaseline, ...visible } = request;
  return visible;
}
function result(status: string, fields: Record<string, unknown> = {}) {
  const details = { status, ...fields };
  return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
}

/** A prompt draft is context, never workflow approval or permission to execute. */
export function registerPromptEditor(pi: ExtensionAPI, deps: Dependencies): void {
  let pending: PromptRequest | undefined;
  let generation = 0;
  let activity: ReturnType<typeof startWorkflowActivity> | undefined;
  const stop = () => { activity?.stop(); activity = undefined; };
  const reset = () => { generation++; pending = undefined; stop(); };
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_end", stop);
  pi.on("agent_start", (_event, ctx) => {
    if (pending && !pending.improved) { stop(); activity = startWorkflowActivity(ctx, "Coordinator: improving your prompt"); }
  });

  const begin = async (args: string, ctx: ExtensionCommandContext, mode: PromptRequest["mode"]) => {
    if (!ctx.hasUI) { deps.report("Prompt editor unavailable", "Use an interactive session to prepare a prompt draft."); return; }
    const turn = ++generation;
    pending = undefined;
    stop();
    const editorBefore = ctx.ui.getEditorText();
    const original = args.trim() ? args : editorBefore.trim() ? editorBefore : await ctx.ui.editor("Prompt to improve", "");
    if (turn !== generation || !original?.trim()) return;
    if (bytes(original) > 16_384) { deps.report("Prompt is too large", "Use a prompt up to 16 KiB; reference large source documents instead of pasting them."); return; }
    const request: PromptRequest = { requestId: randomUUID(), original, mode, cwd: ctx.cwd, editorBefore };
    pending = request;
    activity = startWorkflowActivity(ctx, "Coordinator: preparing prompt context");
    try {
      let context = "";
      try {
        context = await deps.context?.(ctx) ?? "";
        if (bytes(context) > 8192) context = "Recorded project context exceeded the 8 KiB budget and was omitted. Inspect relevant sources before adding factual context.";
      } catch {
        context = "Recorded project context is unavailable. Preserve the original request and label missing context rather than inventing it.";
      }
      if (turn !== generation || pending !== request) return;
      pi.sendUserMessage(buildPromptEnhancementInstructions({ request: original, mode, context, requestId: request.requestId }), {
        deliverAs: "followUp", expandPromptTemplates: false,
      });
      deps.report("Prompt editing started", "Main Pi will return a reviewable draft. No plan, writer, model preference, or goal is started or changed by this command.");
    } catch (error) {
      if (pending === request) { pending = undefined; stop(); }
      deps.report("Prompt editing unavailable", error instanceof Error ? error.message : String(error));
    }
  };
  for (const [name, mode] of [
    ["improve-prompt", "improve"], ["improveprompt", "improve"],
    ["enhance-prompt", "enhance"], ["enhance", "enhance"], ["reprompt", "enhance"],
  ] as const) pi.registerCommand(name, {
    description: mode === "improve" ? "Clarify a prompt while preserving its scope; preview only" : "Enrich a prompt with labeled context, constraints, and success criteria; preview only",
    handler: (args, ctx) => begin(args, ctx, mode),
  });

  pi.registerTool({
    name: "workbench_prompt", label: "Workbench Prompt",
    description: "Inspect the active prompt-editing request or return Main Pi's proposed rewrite. Drafts do not authorize execution or change the user's editor.",
    promptSnippet: "Return an intent-preserving prompt draft for the user's review",
    promptGuidelines: [
      "Use after /improve-prompt, /enhance-prompt, or /reprompt. Keep the original intent, required experiences, exact model choices, source restrictions, and non-goals.",
      "For preview, provide improved plus concise changes, assumptions, and unresolved material questions. These are proposals, not verified facts or approved requirements. Do not add a numerical quality score.",
      "Return the draft in your final response. The user can run /prompt-use to place it in their editor; never submit it or start a workflow automatically.",
    ],
    parameters: Type.Object({
      action: StringEnum(["status", "preview"] as const), requestId: Type.Optional(Type.String()),
      improved: Type.Optional(Type.String()),
      changes: Type.Optional(Type.Array(Type.String())), assumptions: Type.Optional(Type.Array(Type.String())), questions: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      throwIfWorkflowCancelled(signal);
      if (params.action === "status") return result(pending && pending.cwd === ctx.cwd ? "pending" : "idle", pending && pending.cwd === ctx.cwd ? publicRequest(pending) : {});
      if (!pending || pending.cwd !== ctx.cwd || params.requestId !== pending.requestId) throw new Error("Prompt request is missing, stale, or belongs to another session. Start prompt editing again.");
      if (!params.improved?.trim() || bytes(params.improved) > 32_768) throw new Error("A prompt draft must be nonblank and at most 32 KiB.");
      const lists = { changes: params.changes ?? [], assumptions: params.assumptions ?? [], questions: params.questions ?? [] };
      for (const values of Object.values(lists)) {
        if (values.length > 8 || values.some((value) => !value.trim() || bytes(value) > 500)) throw new Error("Use at most 8 nonblank items of 500 bytes per explanation list.");
      }
      pending = { ...pending, improved: params.improved, ...lists };
      stop();
      return result("preview", { ...publicRequest(pending), next: "Review this proposed rewrite. /prompt-use places it in the editor without submitting it. Original intent and native workflow approval remain separate." });
    },
  });
  pi.registerCommand("prompt-use", {
    description: "Place the last reviewed prompt draft in the editor without submitting it",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || !pending?.improved || pending.cwd !== ctx.cwd) { deps.report("No prompt draft", "Prepare and review a prompt with /improve-prompt or /enhance-prompt first."); return; }
      const current = ctx.ui.getEditorText();
      if (current.trim() && current !== pending.editorBefore && current !== pending.improved) { deps.report("Editor text preserved", "Your input changed during prompt editing. Copy the proposed draft from the conversation; your current input was not replaced."); return; }
      ctx.ui.setEditorText(pending.improved);
      deps.report("Prompt placed in editor", "Edit or submit it when ready. No workflow has started.");
    },
  });
}
