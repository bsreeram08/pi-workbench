import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const XAI_PROVIDER = "xai";
const XAI_API_KEY_URL = "https://api.x.ai/v1/api-key";
const XAI_MANAGEMENT_API = "https://management-api.x.ai";
const XAI_GROK_PROXY = "https://cli-chat-proxy.grok.com/v1";
const XAI_GROK_CREDITS_URL = `${XAI_GROK_PROXY}/billing?format=credits`;
const XAI_GROK_USER_URL = `${XAI_GROK_PROXY}/user`;
const XAI_GROK_CLIENT_VERSION = "0.2.101";
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const REQUEST_TIMEOUT_MS = 10_000;
const NETWORK_RETRY_DELAY_MS = 200;
const GENERIC_COMMAND_ERROR = "Could not load coding-plan usage. Check your connection or run /login, then try again.";

interface JsonObject {
  [key: string]: unknown;
}

interface UsageWindow {
  group: string;
  allowed: boolean | undefined;
  limitReached: boolean | undefined;
  usedPercent: number;
  remainingPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAtSeconds: number;
}

export interface CodingPlanUsage {
  provider: string;
  planType: string;
  allowed: boolean | undefined;
  limitReached: boolean | undefined;
  windows: UsageWindow[];
  prepaidCreditsUsd?: number;
}

export interface UsageRequest {
  baseUrl: string;
  token: string;
  accountId: string;
  headers?: Record<string, string | null | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

export type UsageReporter = (title: string, body: string) => void;

class SafeUsageError extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percentage(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseWindow(
  value: unknown,
  group: string,
  allowed: boolean | undefined,
  limitReached: boolean | undefined,
): UsageWindow | undefined {
  if (!isObject(value)) return undefined;
  const usedPercent = finiteNumber(value.used_percent);
  const windowSeconds = finiteNumber(value.limit_window_seconds);
  const resetAfterSeconds = finiteNumber(value.reset_after_seconds);
  const resetAtSeconds = finiteNumber(value.reset_at);
  if (
    usedPercent === undefined
    || windowSeconds === undefined
    || resetAfterSeconds === undefined
    || resetAtSeconds === undefined
  ) {
    return undefined;
  }
  const used = percentage(usedPercent);
  return {
    group,
    allowed,
    limitReached,
    usedPercent: used,
    remainingPercent: 100 - used,
    windowSeconds: Math.max(0, Math.round(windowSeconds)),
    resetAfterSeconds: Math.max(0, Math.round(resetAfterSeconds)),
    resetAtSeconds: Math.max(0, Math.round(resetAtSeconds)),
  };
}

function addRateLimitWindows(windows: UsageWindow[], value: unknown, group: string): void {
  if (!isObject(value)) return;
  const allowed = typeof value.allowed === "boolean" ? value.allowed : undefined;
  const limitReached = typeof value.limit_reached === "boolean" ? value.limit_reached : undefined;
  const primary = parseWindow(value.primary_window, group, allowed, limitReached);
  const secondary = parseWindow(value.secondary_window, group, allowed, limitReached);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
}

export function parseOpenAiCodexUsage(payload: unknown): CodingPlanUsage {
  if (!isObject(payload) || typeof payload.plan_type !== "string" || !payload.plan_type.trim()) {
    throw new SafeUsageError("OpenAI Codex returned an invalid usage response.");
  }
  const windows: UsageWindow[] = [];
  addRateLimitWindows(windows, payload.rate_limit, "Coding plan");

  if (Array.isArray(payload.additional_rate_limits)) {
    for (const value of payload.additional_rate_limits) {
      if (!isObject(value)) continue;
      const name = typeof value.limit_name === "string" && value.limit_name.trim()
        ? value.limit_name.trim()
        : "Additional limit";
      addRateLimitWindows(windows, value.rate_limit, name);
    }
  }

  const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : undefined;
  return {
    provider: "OpenAI Codex",
    planType: payload.plan_type.trim(),
    allowed: typeof rateLimit?.allowed === "boolean" ? rateLimit.allowed : undefined,
    limitReached: typeof rateLimit?.limit_reached === "boolean" ? rateLimit.limit_reached : undefined,
    windows,
  };
}

export function extractChatGptAccountId(token: string): string {
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) throw new Error("invalid token");
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!isObject(payload)) throw new Error("invalid payload");
    const auth = payload[OPENAI_AUTH_CLAIM];
    if (!isObject(auth) || typeof auth.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) {
      throw new Error("missing account id");
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new SafeUsageError("OpenAI Codex authentication is missing its account identifier. Run /login again.");
  }
}

function usageEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.includes("/backend-api")
    ? `${normalized}/wham/usage`
    : `${normalized}/api/codex/usage`;
}

function requestError(error: unknown, timeoutSignal: AbortSignal, callerSignal?: AbortSignal): SafeUsageError {
  if (timeoutSignal.aborted) return new SafeUsageError("OpenAI Codex usage request timed out.");
  if (callerSignal?.aborted) return new SafeUsageError("OpenAI Codex usage request was cancelled.");
  return new SafeUsageError("Could not reach the OpenAI Codex usage service.");
}

export async function fetchOpenAiCodexUsage(request: UsageRequest): Promise<CodingPlanUsage> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${request.token}`);
  headers.set("ChatGPT-Account-Id", request.accountId);
  headers.set("Accept", "application/json");

  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await (request.fetch ?? globalThis.fetch)(usageEndpoint(request.baseUrl), {
        method: "GET",
        headers,
        signal,
      });
      break;
    } catch (error) {
      if (attempt === 1 || signal.aborted) throw requestError(error, timeoutSignal, request.signal);
      try {
        await delay(request.retryDelayMs ?? NETWORK_RETRY_DELAY_MS, undefined, { signal });
      } catch (delayError) {
        throw requestError(delayError, timeoutSignal, request.signal);
      }
    }
  }

  if (!response) throw new SafeUsageError("Could not reach the OpenAI Codex usage service.");
  if (!response.ok) {
    throw new SafeUsageError(`OpenAI Codex usage request failed (${response.status}). Run /login if the session expired.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal.aborted) throw requestError(error, timeoutSignal, request.signal);
    throw new SafeUsageError("OpenAI Codex returned an invalid usage response.");
  }
  return parseOpenAiCodexUsage(payload);
}

function centValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (!isObject(value)) return undefined;
  const raw = value.val;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return undefined;
}

function pickObject(value: unknown, ...keys: string[]): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    if (isObject(value[key])) return value[key];
  }
  return undefined;
}

function pickString(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

function pickNumber(value: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = finiteNumber(value[key]);
    if (raw !== undefined) return raw;
  }
  return undefined;
}

export function parseXaiGrokCredits(payload: unknown): CodingPlanUsage {
  if (!isObject(payload)) throw new SafeUsageError("xAI returned an invalid usage response.");
  const config = pickObject(payload, "config") ?? payload;
  const percent = pickNumber(config, "creditUsagePercent", "credit_usage_percent");
  const period = pickObject(config, "currentPeriod", "current_period");
  const end = (period && pickString(period, "end"))
    ?? pickString(config, "billingPeriodEnd", "billing_period_end");
  const start = (period && pickString(period, "start"))
    ?? pickString(config, "billingPeriodStart", "billing_period_start");
  const usedCents = centValue(config.used);
  const limitCents = centValue(config.monthlyLimit ?? config.monthly_limit);
  let usedPercent = percent !== undefined ? percentage(percent) : undefined;
  if (usedPercent === undefined && usedCents !== undefined && limitCents && limitCents > 0) {
    usedPercent = percentage((usedCents / limitCents) * 100);
  }
  const resetAtMs = end ? Date.parse(end) : Number.NaN;
  const startMs = start ? Date.parse(start) : Number.NaN;
  const resetAtSeconds = Number.isFinite(resetAtMs) ? Math.max(0, Math.round(resetAtMs / 1000)) : 0;
  const windowSeconds = Number.isFinite(startMs) && resetAtSeconds > 0
    ? Math.max(0, resetAtSeconds - Math.round(startMs / 1000))
    : 604_800;
  const windows: UsageWindow[] = [];
  if (usedPercent !== undefined) {
    windows.push({
      group: "Included credits",
      allowed: usedPercent < 100,
      limitReached: usedPercent >= 100,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      windowSeconds,
      resetAfterSeconds: resetAtSeconds > 0 ? Math.max(0, resetAtSeconds - Math.round(Date.now() / 1000)) : 0,
      resetAtSeconds,
    });
  }
  const prepaid = centValue(config.prepaidBalance ?? config.prepaid_balance);
  const tier = pickString(payload, "subscriptionTier", "subscription_tier") ?? "Grok";
  if (usedPercent === undefined && prepaid === undefined && windows.length === 0) {
    throw new SafeUsageError("xAI returned an invalid usage response.");
  }
  return {
    provider: "xAI",
    planType: tier,
    allowed: usedPercent === undefined ? (prepaid !== undefined ? prepaid > 0 : undefined) : usedPercent < 100,
    limitReached: usedPercent !== undefined ? usedPercent >= 100 : prepaid !== undefined ? prepaid <= 0 : undefined,
    windows,
    prepaidCreditsUsd: prepaid !== undefined ? Math.max(0, prepaid) / 100 : undefined,
  };
}

export function parseXaiPrepaidBalance(payload: unknown, teamBlocked?: boolean): CodingPlanUsage {
  if (!isObject(payload)) throw new SafeUsageError("xAI returned an invalid usage response.");
  const total = centValue(pickObject(payload, "total") ?? payload.total);
  if (total === undefined) throw new SafeUsageError("xAI returned an invalid usage response.");
  const remainingUsd = Math.abs(total) / 100;
  return {
    provider: "xAI",
    planType: "API prepaid",
    allowed: teamBlocked === true ? false : remainingUsd > 0,
    limitReached: teamBlocked === true || remainingUsd <= 0,
    windows: [],
    prepaidCreditsUsd: remainingUsd,
  };
}

function grokCliProxyHeaders(userId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `grok-shell/${XAI_GROK_CLIENT_VERSION}`,
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": XAI_GROK_CLIENT_VERSION,
    "x-grok-client-mode": "interactive",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
  };
  if (userId) headers["x-userid"] = userId;
  return headers;
}

async function jsonGet(
  url: string,
  token: string,
  request: Pick<UsageRequest, "headers" | "signal" | "timeoutMs" | "retryDelayMs" | "fetch">,
  unreachable: string,
  failed: (status: number) => string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const headers = new Headers();
  for (const [name, value] of Object.entries({ ...request.headers, ...extraHeaders })) {
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/json");
  const timeoutSignal = AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await (request.fetch ?? globalThis.fetch)(url, { method: "GET", headers, signal });
      break;
    } catch (error) {
      if (attempt === 1 || signal.aborted) {
        if (timeoutSignal.aborted) throw new SafeUsageError("xAI usage request timed out.");
        if (request.signal?.aborted) throw new SafeUsageError("xAI usage request was cancelled.");
        throw new SafeUsageError(unreachable);
      }
      try {
        await delay(request.retryDelayMs ?? NETWORK_RETRY_DELAY_MS, undefined, { signal });
      } catch {
        throw new SafeUsageError(unreachable);
      }
    }
  }
  if (!response) throw new SafeUsageError(unreachable);
  if (!response.ok) throw new SafeUsageError(failed(response.status));
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw new SafeUsageError("xAI usage request timed out.");
    throw new SafeUsageError("xAI returned an invalid usage response.");
  }
}

export async function fetchXaiUsage(request: Omit<UsageRequest, "accountId" | "baseUrl"> & { baseUrl?: string }): Promise<CodingPlanUsage> {
  if (typeof request.token !== "string" || !request.token) {
    throw new SafeUsageError("xAI is not authenticated. Run /login first.");
  }
  const token = request.token;
  const looksLikeApiKey = token.startsWith("xai-");
  const tryCredits = async (): Promise<CodingPlanUsage> => {
    const user = await jsonGet(
      XAI_GROK_USER_URL,
      token,
      request,
      "Could not reach the xAI usage service.",
      (status) => `xAI usage request failed (${status}). Run /login if the session expired.`,
      grokCliProxyHeaders(),
    );
    const userId = isObject(user) ? pickString(user, "userId", "user_id") : undefined;
    if (!userId || !/^[\x21-\x7e]{1,256}$/.test(userId)) {
      throw new SafeUsageError("xAI account identity could not be verified. Run /login again.");
    }
    const payload = await jsonGet(
      XAI_GROK_CREDITS_URL,
      token,
      request,
      "Could not reach the xAI usage service.",
      (status) => `xAI usage request failed (${status}). Run /login if the session expired.`,
      grokCliProxyHeaders(userId),
    );
    return parseXaiGrokCredits(payload);
  };
  const tryPrepaid = async (): Promise<CodingPlanUsage> => {
    const keyInfo = await jsonGet(
      XAI_API_KEY_URL,
      token,
      request,
      "Could not reach the xAI usage service.",
      (status) => `xAI usage request failed (${status}). Run /login if the session expired.`,
    );
    if (!isObject(keyInfo)) throw new SafeUsageError("xAI returned an invalid usage response.");
    const teamId = pickString(keyInfo, "team_id", "teamId");
    const blocked = keyInfo.api_key_blocked === true || keyInfo.team_blocked === true
      || keyInfo.apiKeyBlocked === true || keyInfo.teamBlocked === true;
    if (!teamId) {
      return {
        provider: "xAI",
        planType: "API key",
        allowed: blocked ? false : undefined,
        limitReached: blocked ? true : undefined,
        windows: [],
      };
    }
    const prepaid = await jsonGet(
      `${XAI_MANAGEMENT_API}/v1/billing/teams/${encodeURIComponent(teamId)}/prepaid/balance`,
      token,
      request,
      "Could not reach the xAI usage service.",
      (status) => `xAI prepaid-credit lookup failed (${status}). Check console.x.ai or use a management-capable credential.`,
    );
    return parseXaiPrepaidBalance(prepaid, blocked);
  };

  if (looksLikeApiKey) {
    try {
      return await tryPrepaid();
    } catch (error) {
      if (error instanceof SafeUsageError && /failed \(4\d\d\)/.test(error.message)) {
        try { return await tryCredits(); } catch { throw error; }
      }
      throw error;
    }
  }
  try {
    return await tryCredits();
  } catch (error) {
    try {
      return await tryPrepaid();
    } catch {
      throw error;
    }
  }
}

function titleCasePlan(planType: string): string {
  const known: Record<string, string> = {
    prolite: "Pro Lite",
    free_workspace: "Free Workspace",
    self_serve_business_prolite: "Business Pro Lite",
    self_serve_business_usage_based: "Business Usage Based",
  };
  return known[planType] ?? (
    planType
      .replace(/[\r\n]+/g, " ")
      .split("_")
      .filter(Boolean)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join(" ") || "Unknown"
  );
}

function windowLabel(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400}-day window`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}-hour window`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}-minute window`;
  return "Usage window";
}

function relativeReset(resetAtMs: number, nowMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil((resetAtMs - nowMs) / 60_000));
  if (totalMinutes < 60) return `in ${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `in ${totalHours}h${minutes ? ` ${minutes}m` : ""}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `in ${days}d${hours ? ` ${hours}h` : ""}`;
}

function resetDescription(window: UsageWindow, nowMs: number): string {
  const resetAtMs = window.resetAtSeconds > 0
    ? window.resetAtSeconds * 1000
    : nowMs + window.resetAfterSeconds * 1000;
  const localTime = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAtMs));
  return `${relativeReset(resetAtMs, nowMs)} · ${localTime}`;
}

function statusLabel(allowed: boolean | undefined, limitReached: boolean | undefined): string {
  if (limitReached === true || allowed === false) return "Limit reached";
  if (allowed === true && limitReached === false) return "Available";
  return "Unknown";
}

function markdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/([*_`])/g, "\\$1")
    .trim();
}

function markdownCell(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|");
}

export function formatCodingPlanUsage(usage: CodingPlanUsage, nowMs = Date.now()): string {
  const lines = [
    `**Provider:** ${markdownText(usage.provider)}`,
    `**Plan:** ${markdownText(titleCasePlan(usage.planType))}`,
    `**Coding-plan status:** ${statusLabel(usage.allowed, usage.limitReached)}`,
    "",
  ];

  if (usage.prepaidCreditsUsd !== undefined) {
    lines.push(`**Prepaid credits:** $${usage.prepaidCreditsUsd.toFixed(2)}`);
  }

  if (usage.windows.length === 0) {
    if (usage.prepaidCreditsUsd === undefined) lines.push("No usage-window details were returned by the provider.");
  } else {
    lines.push("| Limit | Status | Remaining | Used | Resets |", "|---|---|---:|---:|---|");
    for (const window of usage.windows) {
      const label = window.group === "Coding plan"
        ? windowLabel(window.windowSeconds)
        : `${window.group} · ${windowLabel(window.windowSeconds)}`;
      lines.push(
        `| ${markdownCell(label)} | ${statusLabel(window.allowed, window.limitReached)} | **${window.remainingPercent}%** | ${window.usedPercent}% | ${resetDescription(window, nowMs)} |`,
      );
    }
  }
  lines.push("", "Provider quota is fetched only when `/usage` is run; credentials are never displayed or stored by Workbench.");
  return lines.join("\n");
}

export function usageCommandErrorMessage(error: unknown): string {
  return error instanceof SafeUsageError ? error.message : GENERIC_COMMAND_ERROR;
}

export function registerUsageCommand(pi: ExtensionAPI, report: UsageReporter): void {
  pi.registerCommand("usage", {
    description: "Show remaining usage and reset times for the active coding plan",
    handler: async (_args, ctx) => {
      const providerId = ctx.model?.provider;
      if (!providerId) {
        ctx.ui.notify("No active model is selected.", "warning");
        return;
      }
      if (providerId !== OPENAI_CODEX_PROVIDER && providerId !== XAI_PROVIDER) {
        const provider = ctx.modelRegistry.getProviderDisplayName(providerId);
        report("Coding plan usage", `Usage lookup is not yet supported for **${markdownText(provider)}**.`);
        return;
      }

      try {
        let resolved: { auth?: { apiKey?: string; headers?: Record<string, string | null | undefined>; baseUrl?: string } } | undefined;
        try {
          resolved = await ctx.modelRegistry.getProviderAuth(providerId);
        } catch {
          throw new SafeUsageError(
            providerId === XAI_PROVIDER
              ? "xAI authentication failed. Run /login again."
              : "OpenAI Codex authentication failed. Run /login again.",
          );
        }
        const auth = resolved?.auth;
        const token = auth?.apiKey;
        if (typeof token !== "string" || !token) {
          ctx.ui.notify(
            providerId === XAI_PROVIDER
              ? "xAI is not authenticated. Run /login first."
              : "OpenAI Codex is not authenticated. Run /login first.",
            "warning",
          );
          return;
        }
        const usage = providerId === XAI_PROVIDER
          ? await fetchXaiUsage({
            token,
            headers: auth.headers,
            baseUrl: auth.baseUrl,
          })
          : await fetchOpenAiCodexUsage({
            baseUrl: auth.baseUrl ?? ctx.model?.baseUrl ?? "https://chatgpt.com/backend-api",
            token,
            accountId: extractChatGptAccountId(token),
            headers: auth.headers,
          });
        report("Coding plan usage", formatCodingPlanUsage(usage));
      } catch (error) {
        ctx.ui.notify(usageCommandErrorMessage(error), "error");
      }
    },
  });
}
