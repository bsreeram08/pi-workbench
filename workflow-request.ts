export interface PlanRequest {
  pipeline: boolean;
  visual: boolean;
  revise: boolean;
  task: string;
  feedback: string;
}

const FLAG = /^(--pipeline|--visual|--ui|--revise)(?:\s+|$)/i;
const REVISE_SHORTHAND = /^revise (?:the )?plan[.!]?$/i;

/** Leading `/plan` flags in any order. Unknown `--` tokens stay in the task. */
export function parsePlanRequest(raw: string): PlanRequest {
  let rest = raw.trim();
  let pipeline = false;
  let visual = false;
  let revise = false;
  if (REVISE_SHORTHAND.test(rest)) return { pipeline: false, visual: false, revise: true, task: "", feedback: "" };

  while (true) {
    const match = rest.match(FLAG);
    if (!match) break;
    const flag = match[1]!.toLowerCase();
    if (flag === "--pipeline") pipeline = true;
    else if (flag === "--visual" || flag === "--ui") visual = true;
    else revise = true;
    rest = rest.slice(match[0].length).trim();
  }

  if (REVISE_SHORTHAND.test(rest)) return { pipeline, visual, revise: true, task: "", feedback: "" };
  if (revise) return { pipeline, visual, revise: true, task: "", feedback: rest };
  return { pipeline, visual, revise: false, task: rest, feedback: "" };
}
