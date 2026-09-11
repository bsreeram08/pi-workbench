import { describe, expect, test } from "bun:test";
import {
  extractChatGptAccountId,
  fetchOpenAiCodexUsage,
  fetchXaiUsage,
  formatCodingPlanUsage,
  parseOpenAiCodexUsage,
  parseXaiGrokCredits,
  parseXaiPrepaidBalance,
  usageCommandErrorMessage,
} from "../usage.ts";

const usagePayload = {
  plan_type: "prolite",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: 1_700_086_400,
    },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 25.4,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
          reset_at: 1_700_003_600,
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_after_seconds: 604_800,
          reset_at: 1_700_604_800,
        },
      },
    },
  ],
};

describe("coding plan usage", () => {
  test("parses the current OpenAI Codex usage payload and calculates remaining quota", () => {
    const usage = parseOpenAiCodexUsage(usagePayload);

    expect(usage.planType).toBe("prolite");
    expect(usage.allowed).toBe(true);
    expect(usage.limitReached).toBe(false);
    expect(usage.windows).toHaveLength(3);
    expect(usage.windows.map((window) => [window.group, window.usedPercent, window.remainingPercent])).toEqual([
      ["Coding plan", 12, 88],
      ["GPT-5.3-Codex-Spark", 25, 75],
      ["GPT-5.3-Codex-Spark", 0, 100],
    ]);
  });

  test("formats remaining percentages, window lengths, plan tier, and reset countdowns", () => {
    const report = formatCodingPlanUsage(parseOpenAiCodexUsage(usagePayload), 1_700_000_000_000);

    expect(report).toContain("**Plan:** Pro Lite");
    expect(report).toContain("**Coding-plan status:** Available");
    expect(report).toContain("| 7-day window | Available | **88%** | 12% | in 1d");
    expect(report).toContain("GPT-5.3-Codex-Spark · 5-hour window");
    expect(report).toContain("**75%**");
    expect(report).toContain("credentials are never displayed or stored");
  });

  test("extracts the ChatGPT account id without exposing token data in failures", () => {
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_demo" },
    })).toString("base64url");

    expect(extractChatGptAccountId(`header.${payload}.signature`)).toBe("acct_demo");
    expect(() => extractChatGptAccountId("secret-token-value")).toThrow("Run /login again");
    try {
      extractChatGptAccountId("secret-token-value");
    } catch (error) {
      expect(String(error)).not.toContain("secret-token-value");
    }
  });

  test("uses the official ChatGPT usage endpoint and required account headers", async () => {
    let requestedUrl = "";
    let authorization = "";
    let accountId = "";
    const fakeFetch: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      const headers = new Headers(init?.headers);
      authorization = headers.get("Authorization") ?? "";
      accountId = headers.get("ChatGPT-Account-Id") ?? "";
      return new Response(JSON.stringify(usagePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api/",
      token: "token_demo",
      accountId: "acct_demo",
      fetch: fakeFetch,
    });

    expect(requestedUrl).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(authorization).toBe("Bearer token_demo");
    expect(accountId).toBe("acct_demo");
  });

  test("does not retry or include provider response bodies in HTTP/auth errors", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts += 1;
      return new Response("private provider details", { status: 401 });
    };

    try {
      await fetchOpenAiCodexUsage({
        baseUrl: "https://chatgpt.com/backend-api",
        token: "token_demo",
        accountId: "acct_demo",
        fetch: fakeFetch,
      });
      throw new Error("expected request to fail");
    } catch (error) {
      expect(String(error)).toContain("401");
      expect(String(error)).not.toContain("private provider details");
      expect(String(error)).not.toContain("token_demo");
      expect(attempts).toBe(1);
    }
  });

  test("does not retry malformed successful responses", async () => {
    let attempts = 0;
    const malformedFetch: typeof fetch = async () => {
      attempts += 1;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      fetch: malformedFetch,
    })).rejects.toThrow("invalid usage response");
    expect(attempts).toBe(1);
  });

  test("rejects missing required schema fields and never reports unknown availability as available", () => {
    expect(() => parseOpenAiCodexUsage({})).toThrow("invalid usage response");

    const usage = parseOpenAiCodexUsage({ plan_type: "plus", rate_limit: null });
    const report = formatCodingPlanUsage(usage, 1_700_000_000_000);
    expect(report).toContain("**Coding-plan status:** Unknown");
    expect(report).not.toContain("**Coding-plan status:** Available");
  });

  test("preserves model-specific limit status and escapes provider labels in Markdown tables", () => {
    const payload = structuredClone(usagePayload);
    payload.additional_rate_limits[0]!.limit_name = "Model | Premium\nalert";
    payload.additional_rate_limits[0]!.rate_limit.allowed = false;
    payload.additional_rate_limits[0]!.rate_limit.limit_reached = true;

    const report = formatCodingPlanUsage(parseOpenAiCodexUsage(payload), 1_700_000_000_000);
    expect(report).toContain("Model \\| Premium alert · 5-hour window | Limit reached");
    expect(report).not.toContain("Premium\nalert");
  });

  test("maps arbitrary credential-resolution errors to a fixed secret-safe message", () => {
    const message = usageCommandErrorMessage(new Error("refresh failed: private upstream response token_demo"));
    expect(message).toBe("Could not load coding-plan usage. Check your connection or run /login, then try again.");
    expect(message).not.toContain("private upstream response");
    expect(message).not.toContain("token_demo");
  });

  test("retries one transient network failure before reporting the service as unreachable", async () => {
    let attempts = 0;
    const flakyFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(usagePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const usage = await fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      retryDelayMs: 0,
      fetch: flakyFetch,
    });
    expect(attempts).toBe(2);
    expect(usage.planType).toBe("prolite");
  });

  test("stops after one retry when the service remains unreachable", async () => {
    let attempts = 0;
    const failedFetch: typeof fetch = async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    };

    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      retryDelayMs: 0,
      fetch: failedFetch,
    })).rejects.toThrow("Could not reach");
    expect(attempts).toBe(2);
  });

  test("honors cancellation and the overall timeout during the retry delay", async () => {
    let cancellationAttempts = 0;
    const cancellationController = new AbortController();
    const cancellationFetch: typeof fetch = async () => {
      cancellationAttempts += 1;
      setTimeout(() => cancellationController.abort(), 0);
      throw new TypeError("fetch failed");
    };
    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      signal: cancellationController.signal,
      timeoutMs: 60_000,
      retryDelayMs: 60_000,
      fetch: cancellationFetch,
    })).rejects.toThrow("cancelled");
    expect(cancellationAttempts).toBe(1);

    let timeoutAttempts = 0;
    const timeoutFetch: typeof fetch = async () => {
      timeoutAttempts += 1;
      throw new TypeError("fetch failed");
    };
    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      timeoutMs: 1,
      retryDelayMs: 60_000,
      fetch: timeoutFetch,
    })).rejects.toThrow("timed out");
    expect(timeoutAttempts).toBe(1);
  });

  test("combines caller cancellation with the request timeout", async () => {
    const waitingFetch: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });

    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      timeoutMs: 1,
      fetch: waitingFetch,
    })).rejects.toThrow("timed out");

    const controller = new AbortController();
    controller.abort();
    await expect(fetchOpenAiCodexUsage({
      baseUrl: "https://chatgpt.com/backend-api",
      token: "token_demo",
      accountId: "acct_demo",
      signal: controller.signal,
      timeoutMs: 60_000,
      fetch: waitingFetch,
    })).rejects.toThrow("cancelled");
  });

  test("parses xAI SuperGrok credits and prepaid API balance", () => {
    const credits = parseXaiGrokCredits({
      subscriptionTier: "SuperGrok",
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-06-01T00:00:00Z",
          end: "2026-06-08T00:00:00Z",
        },
        prepaidBalance: { val: 1250 },
      },
    });
    expect(credits.provider).toBe("xAI");
    expect(credits.planType).toBe("SuperGrok");
    expect(credits.windows[0]?.usedPercent).toBe(43);
    expect(credits.windows[0]?.remainingPercent).toBe(57);
    expect(credits.prepaidCreditsUsd).toBe(12.5);
    const report = formatCodingPlanUsage(credits, Date.parse("2026-06-04T00:00:00Z"));
    expect(report).toContain("**Prepaid credits:** $12.50");
    expect(report).toContain("Included credits");

    const prepaid = parseXaiPrepaidBalance({ total: { val: "-2317" } });
    expect(prepaid.planType).toBe("API prepaid");
    expect(prepaid.prepaidCreditsUsd).toBe(23.17);
    expect(prepaid.allowed).toBe(true);
    expect(formatCodingPlanUsage(prepaid)).toContain("$23.17");
  });

  test("fetches xAI subscription credits then API prepaid without leaking the token", async () => {
    const urls: string[] = [];
    const creditsFetch: typeof fetch = async (input, init) => {
      urls.push(String(input));
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer oauth-token");
      return new Response(JSON.stringify({
        config: { creditUsagePercent: 10, prepaidBalance: { val: 100 } },
        subscriptionTier: "SuperGrok",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const usage = await fetchXaiUsage({ token: "oauth-token", fetch: creditsFetch });
    expect(urls).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
    expect(usage.planType).toBe("SuperGrok");

    const apiUrls: string[] = [];
    const apiFetch: typeof fetch = async (input) => {
      apiUrls.push(String(input));
      if (String(input).endsWith("/api-key")) {
        return new Response(JSON.stringify({ team_id: "team-demo", api_key_blocked: false }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ total: { val: "-500" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const prepaid = await fetchXaiUsage({ token: "xai-secret-key", fetch: apiFetch });
    expect(apiUrls[0]).toBe("https://api.x.ai/v1/api-key");
    expect(apiUrls[1]).toContain("/v1/billing/teams/team-demo/prepaid/balance");
    expect(prepaid.prepaidCreditsUsd).toBe(5);
    expect(JSON.stringify(apiUrls)).not.toContain("xai-secret-key");
  });
});
