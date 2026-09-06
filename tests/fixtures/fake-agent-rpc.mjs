import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const sessionDir = valueAfter("--session-dir");
const fakeMode = valueAfter("--fake-mode") ?? "complete";
const delayMs = Number(valueAfter("--fake-delay") ?? "0");
const envOutput = valueAfter("--env-output");
const sessionFile = valueAfter("--session") ?? path.join(sessionDir, "fake-session.jsonl");
const sessionId = valueAfter("--session") ? JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]).id : "fake-session-id";
let buffer = "";
let prompt = "";
let waiting = false;
let settled = false;

if (envOutput) {
  fs.writeFileSync(envOutput, JSON.stringify(process.env, null, 2));
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

emit({
  type: "extension_ui_request",
  id: "loadout-1",
  method: "setStatus",
  statusKey: "pi-workbench-child-loadout",
  statusText: JSON.stringify({
    version: 1,
    runId: process.env.PI_WORKBENCH_RUN_ID,
    activeTools: fakeMode === "loadout-mismatch" ? ["read"] : (valueAfter("--tools") ?? "").split(",").filter(Boolean).sort(),
    model: (valueAfter("--model") ?? "").replace(/:(low|medium|high)$/, ""),
    thinking: (valueAfter("--model") ?? "").match(/:(low|medium|high)$/)?.[1],
  }),
});
if (fakeMode === "early-close") process.exit(0);

function ensureSession() {
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(sessionFile)) {
    if (fakeMode === "session-symlink") {
      const outside = path.join(path.dirname(sessionDir), "outside-session.jsonl");
      fs.writeFileSync(outside, "outside\n", { mode: 0o600 });
      fs.symlinkSync(outside, sessionFile);
    } else {
      fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`, { mode: 0o600 });
    }
  }
}

function complete() {
  ensureSession();
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "verified fake output" }], stopReason: "stop" } });
  settled = true;
  emit({ type: "agent_settled" });
}

async function handle(command) {
  if (command.type === "prompt") {
    prompt = command.message ?? "";
    if (fakeMode === "continuation") {
      ensureSession();
      fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: prompt } })}\n`);
    }
    emit({ id: command.id, type: "response", command: "prompt", success: true });
    emit({ type: "agent_start" });
    if (fakeMode === "malformed") {
      process.stdout.write("{not-json\n");
      return;
    }
    if (fakeMode === "hang") return;
    if (fakeMode === "continuation-stale" && valueAfter("--session")) {
      settled = true;
      emit({ type: "agent_settled" });
      return;
    }
    if (fakeMode.startsWith("check-")) {
      const { runCheck } = await import("../../verification.ts");
      const request = { argv: [process.execPath, "-e", 'console.log("real check output")'], criterionIds: ["behavior"], kind: "automated-test" };
      if (fakeMode !== "check-unmatched") emit({ type: "tool_execution_start", toolCallId: "check-1", toolName: "workbench_verify", args: request });
      const result = await runCheck(request, { projectRoot: process.cwd(), evidenceDir: process.env.PI_WORKBENCH_EVIDENCE_DIR, runId: process.env.PI_WORKBENCH_RUN_ID });
      if (fakeMode === "check-tampered") fs.writeFileSync(path.join(process.env.PI_WORKBENCH_EVIDENCE_DIR, `${result.receipt.id}.log`), "forged");
      emit({ type: "tool_execution_end", toolCallId: "check-1", toolName: "workbench_verify", result: { content: [{ type: "text", text: result.output }], details: { receipt: result.receipt } }, isError: false });
      complete();
      return;
    }
    if (["question", "double-question", "concurrent-question", "long-question-id"].includes(fakeMode)) {
      waiting = true;
      emit({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_parent", args: { question: "Which path?" } });
      emit({ type: "extension_ui_request", id: fakeMode === "long-question-id" ? "x".repeat(257) : "ui-1", method: "input", title: "Parent answer required", placeholder: "Which path?" });
      if (fakeMode === "concurrent-question") {
        emit({ type: "extension_ui_request", id: "ui-2", method: "input", title: "Parent answer required", placeholder: "Another path?" });
      }
      return;
    }
    complete();
    return;
  }
  if (command.type === "extension_ui_response") {
    if (!waiting || command.id !== "ui-1") return;
    waiting = false;
    emit({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_parent", args: { question: "Which path?" }, result: { content: [{ type: "text", text: String(command.value ?? "") }] }, isError: false });
    if (fakeMode === "double-question") {
      waiting = true;
      emit({ type: "tool_execution_start", toolCallId: "ask-2", toolName: "ask_parent", args: { question: "Again?" } });
      emit({ type: "extension_ui_request", id: "ui-2", method: "input", title: "Parent answer required", placeholder: "Again?" });
      return;
    }
    complete();
    return;
  }
  if (command.type === "get_last_assistant_text") {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    emit({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: fakeMode === "blank-final" ? "   " : "verified fake output" } });
    return;
  }
  if (command.type === "get_state") {
    ensureSession();
    emit({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionFile, sessionId, isStreaming: !settled, isCompacting: false, pendingMessageCount: 0 } });
    if (fakeMode === "late-message") {
      setTimeout(() => emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "unvalidated late output" }], stopReason: "error" } }), 10);
    }
    return;
  }
  if (command.type === "steer" || command.type === "follow_up") {
    emit({ id: command.id, type: "response", command: command.type, success: true });
    return;
  }
  if (command.type === "abort") {
    emit({ id: command.id, type: "response", command: "abort", success: true });
    setTimeout(() => process.exit(2), 10);
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => {
  if (fakeMode === "late-message") setTimeout(() => process.exit(settled ? 0 : 1), 30);
  else process.exit(settled ? 0 : 1);
});
