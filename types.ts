export type CouncilPhase = "clarifying" | "intent-approved" | "implementing" | "verified" | "force-completed";

export interface AgentSpec {
  id: string;
  title: string;
  description: string;
  triggers: string[];
  readOnly: boolean;
  allowBash?: boolean;
  researchTools?: boolean;
  model?: string;
  fastMode?: boolean;
}

export interface AgentResult {
  runId?: string;
  continuation?: { runId: string; workspaceSnapshot: string };
  agentId: string;
  title: string;
  output: string;
  exitCode: number;
  cancelled?: boolean;
  error?: string;
  verification?: import("./verification.ts").VerificationEvidence;
  routing?: {
    effort: "light" | "standard" | "heavy";
    model: string;
    thinking: "low" | "medium" | "high";
    reason: string;
    budget?: { turns: number; tools: number };
  };
}

export interface CouncilSession {
  version: 1;
  projectRoot: string;
  topic: string;
  phase: CouncilPhase;
  createdAt: string;
  updatedAt: string;
  agents: string[];
  rounds: Array<{
    number: number;
    completedAt: string;
    checkpoint?: string;
  }>;
  implementation?: {
    startedAt: string;
    sessionMode: "same" | "new";
    lastVerification?: {
      passed: boolean;
      output: string;
      completedAt: string;
    };
  };
}

export interface ProjectPaths {
  root: string;
  stateDir: string;
  intent: string;
  decisions: string;
  implementationPlan: string;
  session: string;
  qmd: string;
}

export interface QmdResult {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;
