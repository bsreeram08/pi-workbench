import { expect, test } from "bun:test";
import { assertLoopbackCaptureUrl } from "../visual-capture.ts";

test("host capture URLs must be loopback http(s)", () => {
  expect(assertLoopbackCaptureUrl("http://127.0.0.1:4173/app").href).toBe("http://127.0.0.1:4173/app");
  expect(assertLoopbackCaptureUrl("http://localhost:3000/").hostname).toBe("localhost");
  expect(() => assertLoopbackCaptureUrl("https://example.com")).toThrow("loopback");
  expect(() => assertLoopbackCaptureUrl("file:///tmp/x")).toThrow("http");
  expect(() => assertLoopbackCaptureUrl("http://192.168.1.10/")).toThrow("loopback");
  expect(() => assertLoopbackCaptureUrl("http://user:pass@127.0.0.1/")).toThrow("credentials");
});
