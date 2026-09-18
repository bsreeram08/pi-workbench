import { expect, test } from "bun:test";
import { parsePlanRequest } from "../workflow-request.ts";

test("parses leading plan flags in any order", () => {
  expect(parsePlanRequest("Build a landing page")).toEqual({
    pipeline: false, visual: false, revise: false, task: "Build a landing page", feedback: "",
  });
  expect(parsePlanRequest("--visual Build a landing page")).toEqual({
    pipeline: false, visual: true, revise: false, task: "Build a landing page", feedback: "",
  });
  expect(parsePlanRequest("--ui Build a landing page")).toEqual({
    pipeline: false, visual: true, revise: false, task: "Build a landing page", feedback: "",
  });
  expect(parsePlanRequest("--pipeline --visual Build a landing page")).toEqual({
    pipeline: true, visual: true, revise: false, task: "Build a landing page", feedback: "",
  });
  expect(parsePlanRequest("--visual --pipeline Build a landing page")).toEqual({
    pipeline: true, visual: true, revise: false, task: "Build a landing page", feedback: "",
  });
  expect(parsePlanRequest("--revise Include mobile layout")).toEqual({
    pipeline: false, visual: false, revise: true, task: "", feedback: "Include mobile layout",
  });
  expect(parsePlanRequest("--pipeline --revise Include a complete field policy")).toEqual({
    pipeline: true, visual: false, revise: true, task: "", feedback: "Include a complete field policy",
  });
  expect(parsePlanRequest("--revise --pipeline Include a complete field policy")).toEqual({
    pipeline: true, visual: false, revise: true, task: "", feedback: "Include a complete field policy",
  });
  expect(parsePlanRequest("--visual --revise fix spacing")).toEqual({
    pipeline: false, visual: true, revise: true, task: "", feedback: "fix spacing",
  });
  expect(parsePlanRequest("revise plan")).toEqual({
    pipeline: false, visual: false, revise: true, task: "", feedback: "",
  });
  expect(parsePlanRequest("--pipeline revise plan")).toEqual({
    pipeline: true, visual: false, revise: true, task: "", feedback: "",
  });
  expect(parsePlanRequest("--visual")).toEqual({
    pipeline: false, visual: true, revise: false, task: "", feedback: "",
  });
  expect(parsePlanRequest("--unknown-flag stays in the task")).toEqual({
    pipeline: false, visual: false, revise: false, task: "--unknown-flag stays in the task", feedback: "",
  });
});
