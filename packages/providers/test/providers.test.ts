import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { GoogleGenAI } from "@google/genai";
import { AnthropicProvider, GoogleProvider, OpenAIProvider, providersFromEnv } from "../src/index.js";

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

describe("tool calling", () => {
  const tools = [{ name: "add", description: "Add", inputSchema: { type: "object", properties: {} } }];

  it("Anthropic: sends tools, returns tool_use as toolCalls, replays raw blocks and tool_result", async () => {
    const sent: Array<Record<string, any>> = [];
    const blocks = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "tu1", name: "add", input: { a: 1 } },
    ];
    const fake = {
      messages: {
        create: async (body: Record<string, any>) => {
          sent.push(body);
          return { model: "m", stop_reason: "tool_use", content: blocks, usage: {} };
        },
      },
    } as unknown as Anthropic;
    const p = new AnthropicProvider(fake);
    const first = await p.generate({ model: "m", system: "", messages: [{ role: "user", content: "hi" }], tools });
    expect(first.toolCalls).toEqual([{ id: "tu1", name: "add", args: { a: 1 } }]);
    expect(sent[0]!.tools).toEqual([{ name: "add", description: "Add", input_schema: tools[0]!.inputSchema }]);

    await p.generate({
      model: "m",
      system: "",
      tools,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: first.toolCalls, raw: first.raw },
        { role: "tool", results: [{ callId: "tu1", name: "add", content: "2", isError: true }] },
      ],
    });
    expect(sent[1]!.messages[1]).toEqual({ role: "assistant", content: blocks });
    expect(sent[1]!.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu1", content: "2", is_error: true }],
    });
  });

  it("OpenAI: maps function tools, tool_calls and per-call tool messages", async () => {
    const sent: Array<Record<string, any>> = [];
    const fake = {
      chat: {
        completions: {
          create: async (body: Record<string, any>) => {
            sent.push(body);
            return {
              model: "gpt",
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":1}' } }],
                  },
                },
              ],
            };
          },
        },
      },
    } as unknown as OpenAI;
    const p = new OpenAIProvider(fake);
    const res = await p.generate({ model: "gpt", system: "s", messages: [{ role: "user", content: "hi" }], tools });
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "add", args: { a: 1 } }]);
    expect(sent[0]!.tools[0]).toEqual({ type: "function", function: { name: "add", description: "Add", parameters: tools[0]!.inputSchema } });

    await p.generate({
      model: "gpt",
      system: "s",
      messages: [
        { role: "assistant", content: "", toolCalls: res.toolCalls },
        { role: "tool", results: [{ callId: "call_1", name: "add", content: "2" }, { callId: "call_2", name: "add", content: "3" }] },
      ],
    });
    expect(sent[1]!.messages.slice(1)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "2" },
      { role: "tool", tool_call_id: "call_2", content: "3" },
    ]);
  });

  it("Google: maps function declarations, functionCalls and functionResponses", async () => {
    const sent: Array<Record<string, any>> = [];
    const modelContent = { role: "model", parts: [{ functionCall: { id: "g1", name: "add", args: { a: 1 } }, thoughtSignature: "ts" }] };
    const fake = {
      models: {
        generateContent: async (body: Record<string, any>) => {
          sent.push(body);
          return {
            functionCalls: [{ id: "g1", name: "add", args: { a: 1 } }],
            candidates: [{ content: modelContent }],
          };
        },
      },
    } as unknown as GoogleGenAI;
    const p = new GoogleProvider(fake);
    const res = await p.generate({ model: "gem", system: "s", messages: [{ role: "user", content: "hi" }], tools });
    expect(res.toolCalls).toEqual([{ id: "g1", name: "add", args: { a: 1 } }]);
    expect(sent[0]!.config.tools[0].functionDeclarations[0]).toEqual({ name: "add", description: "Add", parametersJsonSchema: tools[0]!.inputSchema });

    await p.generate({
      model: "gem",
      system: "s",
      messages: [
        { role: "assistant", content: "", toolCalls: res.toolCalls, raw: res.raw },
        { role: "tool", results: [{ callId: "g1", name: "add", content: "2" }] },
      ],
    });
    expect(sent[1]!.contents[0]).toEqual(modelContent);
    expect(sent[1]!.contents[1]).toEqual({
      role: "user",
      parts: [{ functionResponse: { id: "g1", name: "add", response: { output: "2" } } }],
    });
  });
});
