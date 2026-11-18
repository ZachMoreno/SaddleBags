import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, providersFromEnv } from "../src/index.js";

describe("AnthropicProvider", () => {
  it("sends structured output via output_config and joins text blocks", async () => {
    let sent: Record<string, unknown> | undefined;
    const fake = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          sent = body;
          return {
            model: body.model,
            stop_reason: "end_turn",
            content: [{ type: "text", text: '{"n":' }, { type: "text", text: "1}" }],
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        },
      },
    } as unknown as Anthropic;

    const res = await new AnthropicProvider(fake).generate({
      model: "claude-opus-5-5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      jsonSchema: { type: "object" },
      temperature: 0,
    });

    expect(res.text).toBe('{"n":1}');
    expect(sent).toMatchObject({
      model: "claude-opus-5-5",
      system: "sys",
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(sent).not.toHaveProperty("temperature");
  });

  it("throws on refusal", async () => {
    const fake = {
      messages: {
        create: async () => ({
          stop_reason: "refusal",
          stop_details: { explanation: "nope" },
          content: [],
          usage: {},
        }),
      },
    } as unknown as Anthropic;
    await expect(
      new AnthropicProvider(fake).generate({ model: "m", system: "", messages: [] }),
    ).rejects.toThrow(/refused: nope/);
  });
});

describe("providersFromEnv", () => {
  it("registers only providers with credentials", () => {
    expect(providersFromEnv({ OPENAI_API_KEY: "x" }).map((p) => p.id)).toEqual(["openai"]);
  });
});
