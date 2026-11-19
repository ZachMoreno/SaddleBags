/**
 * Reference bag: video brief → script.
 *
 * Every rule here demonstrates one placement on the essay's axes:
 * what resolves it (code or model), and who can change it.
 */
import { z } from "zod";
import {
  defineBag,
  defineEval,
  defineRoute,
  defineRule,
  defineTool,
  pass,
  reject,
  transform,
} from "@saddlebags/sdk";

// ─── Types (the "type-safe decision model") ───────────────────────────────

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5"] as const;

export const BriefClass = z.object({
  format: z.enum(["ad", "explainer", "social", "testimonial"]),
  audience: z.string(),
  targetSeconds: z.number().int().positive(),
  aspect: z.string(),
});
export type BriefClass = z.infer<typeof BriefClass>;

export const Script = z.object({
  title: z.string(),
  aspect: z.string(),
  shots: z
    .array(
      z.object({
        seconds: z.number().positive(),
        visual: z.string(),
        voiceover: z.string(),
      }),
    )
    .min(1),
});
export type Script = z.infer<typeof Script>;

export const ScriptInput = z.object({
  brief: z.string().describe("The video brief, in the client's words"),
  classification: BriefClass,
});
export type ScriptInput = z.infer<typeof ScriptInput>;

// ─── Tools ────────────────────────────────────────────────────────────────

/** A tiny, deterministic stand-in for a stock-footage catalog. */
export const FOOTAGE = [
  { id: "ft-001", tags: ["city", "commute", "train"], aspect: "16:9", seconds: 12 },
  { id: "ft-002", tags: ["city", "commute", "train"], aspect: "9:16", seconds: 10 },
  { id: "ft-003", tags: ["office", "laptop", "small business"], aspect: "16:9", seconds: 15 },
  { id: "ft-004", tags: ["water", "bottle", "product"], aspect: "9:16", seconds: 8 },
  { id: "ft-005", tags: ["kids", "school", "park"], aspect: "16:9", seconds: 9 },
] as const;

export const FootageQuery = z.object({
  query: z.string().describe("Keywords describing the shot, e.g. 'commuters on a train'"),
  aspect: z.string().describe("Aspect ratio of the video, e.g. '9:16'"),
});

const footageSearch = defineTool({
  name: "footage_search",
  description: "Search licensed stock footage. Returns clip IDs to reference in shot visuals.",
  input: FootageQuery,
  run: ({ query, aspect }) => {
    const words = query.toLowerCase().split(/\W+/).filter(Boolean);
    return FOOTAGE.filter((c) => c.aspect === aspect && words.some((w) => c.tags.some((t) => t.includes(w))));
  },
});

// ─── Routes: a model choice per operation, pinned ─────────────────────────

const routes = [
  defineRoute({
    operation: "brief.classify",
    model: "anthropic:claude-opus-5-5",
    system: "You classify video briefs for a production team.",
    output: BriefClass,
    maxTokens: 1024,
  }),
  defineRoute({
    operation: "script.write",
    model: "anthropic:claude-opus-5-5",
    system:
      "You write shot-by-shot video scripts with voiceover. Use footage_search to find stock clips " +
      "and cite clip IDs in shot visuals where they fit.",
    input: ScriptInput,
    output: Script,
    tools: ["footage_search"],
    maxAttempts: 3,
    // Served on /mcp, so agents can request scripts with the house rules applied.
    mcp: {
      expose: true,
      description:
        "Write a shot-by-shot video script with voiceover from a brief and its classification, " +
        "applying the team's pacing, duration and aspect-ratio rules.",
    },
  }),
];

// ─── Rules ────────────────────────────────────────────────────────────────

const rules = [
  // always + prose: anyone can edit it in the Stable.
  defineRule({
    id: "house-style",
    title: "House style",
    operations: ["script.write"],
    condition: { kind: "always" },
    directive: {
      kind: "prose",
      text: "Open on the product or person, never on a logo. Plain language; no jargon in voiceover.",
    },
    authoredBy: "domain-expert",
    editableIn: "stable",
  }),

  // code condition + prose directive: the essay's own example.
  defineRule<ScriptInput>({
    id: "long-form-pacing",
    title: "Tight pacing for long videos",
    operations: ["script.write"],
    condition: { kind: "code", when: (ctx) => ctx.input.classification.targetSeconds > 60 },
    directive: { kind: "prose", text: "Keep pacing tight; cut any shot longer than four seconds." },
    authoredBy: "engineer",
    editableIn: "code",
  }),

  // model-decided condition + prose directive.
  defineRule({
    id: "kids-audience",
    title: "Children's audience",
    operations: ["script.write"],
    condition: { kind: "model", description: "The brief's audience includes children under 13." },
    directive: {
      kind: "prose",
      text: "Use simple words, no calls to purchase, and no urgency language.",
    },
    authoredBy: "domain-expert",
    editableIn: "stable",
  }),

  // always + enforce-tool (transform): searches always use the brief's aspect ratio.
  defineRule<ScriptInput>({
    id: "footage-matches-aspect",
    title: "Footage searches use the video's aspect ratio",
    operations: ["script.write"],
    condition: { kind: "always" },
    directive: {
      kind: "enforce-tool",
      tool: "footage_search",
      check: (args, ctx) => {
        const aspect = normalizeAspect(ctx.input.classification.aspect);
        const a = args as z.infer<typeof FootageQuery>;
        return aspect && a.aspect !== aspect ? transform({ ...a, aspect }) : pass();
      },
    },
    authoredBy: "engineer",
    editableIn: "code",
  }),

  // always + enforce (reject → retry): total duration within ±10% of target.
  defineRule<ScriptInput, Script>({
    id: "duration-fits",
    title: "Duration within 10% of target",
    operations: ["script.write"],
    condition: { kind: "always" },
    directive: {
      kind: "enforce",
      check: (script, ctx) => {
        const target = ctx.input.classification.targetSeconds;
        const total = script.shots.reduce((s, x) => s + x.seconds, 0);
        return Math.abs(total - target) <= target * 0.1
          ? pass()
          : reject(`Shots total ${total}s; target is ${target}s (±10%).`);
      },
    },
    authoredBy: "engineer",
    editableIn: "code",
  }),

  // always + enforce (transform): normalize the aspect ratio.
  defineRule<ScriptInput, Script>({
    id: "aspect-allowed",
    title: "Allowed aspect ratios",
    operations: ["script.write"],
    condition: { kind: "always" },
    directive: {
      kind: "enforce",
      check: (script, ctx) => {
        const aspect = normalizeAspect(script.aspect) ?? normalizeAspect(ctx.input.classification.aspect);
        if (!aspect) return reject(`Aspect "${script.aspect}" is not one of ${ASPECTS.join(", ")}.`);
        return aspect === script.aspect ? pass() : transform({ ...script, aspect });
      },
    },
    authoredBy: "engineer",
    editableIn: "code",
  }),
];

export function normalizeAspect(raw: string): (typeof ASPECTS)[number] | undefined {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "").replace("x", ":");
  const alias: Record<string, (typeof ASPECTS)[number]> = {
    landscape: "16:9",
    widescreen: "16:9",
    vertical: "9:16",
    portrait: "9:16",
    square: "1:1",
  };
  return (ASPECTS as readonly string[]).includes(s) ? (s as (typeof ASPECTS)[number]) : alias[s];
}

// ─── Evals ────────────────────────────────────────────────────────────────

const evals = [
  defineEval<ScriptInput, Script>({
    id: "30s-social-vertical",
    operation: "script.write",
    input: {
      brief: "30-second vertical social ad for a reusable water bottle aimed at commuters.",
      classification: { format: "social", audience: "commuters", targetSeconds: 30, aspect: "9:16" },
    },
    graders: [
      { kind: "code", name: "vertical", assert: (s) => s.aspect === "9:16" || `aspect was ${s.aspect}` },
      { kind: "code", name: "has-voiceover", assert: (s) => s.shots.every((x) => x.voiceover.length > 0) },
      {
        kind: "judge",
        name: "tone",
        rubric: "Upbeat, plain-language, and opens on the product rather than a logo.",
        model: "anthropic:claude-opus-5-5",
      },
    ],
  }),
  defineEval<ScriptInput, Script>({
    id: "90s-explainer-pacing",
    operation: "script.write",
    input: {
      brief: "90-second explainer for a payroll app, for small-business owners.",
      classification: { format: "explainer", audience: "small-business owners", targetSeconds: 90, aspect: "16:9" },
    },
    graders: [
      { kind: "code", name: "tight-pacing", assert: (s) => s.shots.every((x) => x.seconds <= 4) || "a shot is over 4s" },
    ],
  }),
];

export default defineBag({
  name: "@saddlebags/bag-video-brief-to-script",
  version: "0.1.0",
  description: "Classify a video brief, then write a shot list with voiceover.",
  routes,
  rules,
  tools: [footageSearch],
  memory: {
    policy: { org: "review", group: "review", user: "auto" },
    seed: [{ scope: "org", key: "brand.voice", value: "Warm, direct, a little wry." }],
  },
  evals,
});
