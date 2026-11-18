import { describe, expect, it } from "vitest";
import { Harness, MockProvider, runEvals } from "@saddlebags/core";
import bag, { normalizeAspect, type Script } from "../src/index.js";

const shots = (n: number, seconds: number) =>
  Array.from({ length: n }, (_, i) => ({ seconds, visual: `shot ${i}`, voiceover: `line ${i}` }));

const input = (targetSeconds: number, audience = "commuters") => ({
  brief: "brief",
  classification: { format: "ad" as const, audience, targetSeconds, aspect: "9:16" },
});

describe("video-brief-to-script bag", () => {
  it("normalizes aspect aliases", () => {
    expect(normalizeAspect("Vertical")).toBe("9:16");
    expect(normalizeAspect("16x9")).toBe("16:9");
    expect(normalizeAspect("3:2")).toBeUndefined();
  });

  it("fires the essay's pacing predicate only for videos over 60s", async () => {
    const provider = new MockProvider("anthropic", (req) =>
      req.system.startsWith("You decide which rules apply")
        ? '{"ruleIds": []}'
        : JSON.stringify({ title: "t", aspect: "9:16", shots: shots(20, 4.5) }),
    );
    const h = new Harness({ bag, providers: [provider], selectorModel: "anthropic:claude-opus-5-5" });
    const long = await h.run<Script>("script.write", input(90), { scope: { orgId: "o" } });
    expect(long.trace.fired.map((f) => f.ruleId)).toContain("long-form-pacing");
    const writeCall = provider.calls.find((c) => c.system.startsWith("You write"))!;
    expect(writeCall.system).toContain("cut any shot longer than four seconds");
  });

  it("transforms aspect aliases and retries on duration misses", async () => {
    let n = 0;
    const provider = new MockProvider("anthropic", (req) => {
      if (req.system.startsWith("You decide")) return '{"ruleIds": ["kids-audience"]}';
      n++;
      // First draft is 60s for a 30s target; the second fits.
      return JSON.stringify({ title: "t", aspect: "vertical", shots: n === 1 ? shots(10, 6) : shots(10, 3) });
    });
    const h = new Harness({ bag, providers: [provider], selectorModel: "anthropic:claude-opus-5-5" });
    const { output, trace } = await h.run<Script>("script.write", input(30, "kids 8-12"), {
      scope: { orgId: "o" },
    });
    expect(output.aspect).toBe("9:16");
    expect(trace.attempts).toHaveLength(2);
    expect(trace.attempts[0]!.rejections[0]!.ruleId).toBe("duration-fits");
    expect(trace.fired.find((f) => f.ruleId === "kids-audience")?.reason).toBe("selector");
  });

  it("runs its golden evals with code and judge graders", async () => {
    const provider = new MockProvider("anthropic", (req) => {
      if (req.system.startsWith("You decide")) return '{"ruleIds": []}';
      if (req.system.startsWith("You grade")) return '{"pass": true, "reason": "ok"}';
      const target = req.messages[0]!.content.includes("90-second") ? 90 : 30;
      return JSON.stringify({ title: "t", aspect: target === 90 ? "16:9" : "9:16", shots: shots(target / 3, 3) });
    });
    const h = new Harness({ bag, providers: [provider], selectorModel: "anthropic:claude-opus-5-5" });
    const report = await runEvals(h, { judges: [provider] });
    expect(report.passRate).toBe(1);
  });

  it("lets the writer search footage, forcing the brief's aspect ratio", async () => {
    const provider = new MockProvider("anthropic", (req, i) => {
      if (req.system.startsWith("You decide")) return '{"ruleIds": []}';
      if (!req.messages.some((m) => m.role === "tool")) {
        return { toolCalls: [{ id: "t1", name: "footage_search", args: { query: "commute train", aspect: "16:9" } }] };
      }
      return JSON.stringify({ title: "t", aspect: "9:16", shots: shots(10, 3) });
    });
    const h = new Harness({ bag, providers: [provider], selectorModel: "anthropic:claude-opus-5-5" });
    const { trace } = await h.run<Script>("script.write", input(30), { scope: { orgId: "o" } });
    const call = trace.attempts[0]!.toolCalls![0]!;
    expect(call.args).toEqual({ query: "commute train", aspect: "9:16" });
    expect((call.result as Array<{ id: string }>).map((c) => c.id)).toEqual(["ft-002"]);
  });
});
