import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, type Content } from "@google/genai";
import type { ChatMessage, GenerateRequest, GenerateResponse, ModelProvider, ToolCall } from "@saddlebags/sdk";

// ─── Anthropic ────────────────────────────────────────────────────────────

/**
 * Anthropic adapter. Uses structured outputs (`output_config.format`) when the
 * route is typed. Sampling params are not sent: current Claude models reject them.
 * Assistant turns are replayed with their original content blocks (including
 * thinking blocks), as tool use requires.
 */
export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  /** With no client given, credentials resolve from the environment. */
  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: req.messages.map(toAnthropic),
      ...(req.tools && {
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
      }),
      ...(req.jsonSchema && { output_config: { format: { type: "json_schema", schema: req.jsonSchema } } }),
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Model refused: ${res.stop_details?.explanation ?? "no explanation"}`);
    }
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const toolCalls: ToolCall[] = res.content.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id, name: b.name, args: b.input }] : [],
    );
    return {
      text,
      model: res.model,
      ...(toolCalls.length && { toolCalls }),
      raw: { provider: "anthropic", data: res.content },
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

function toAnthropic(m: ChatMessage): Anthropic.MessageParam {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool") {
    return {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.callId,
        content: r.content,
        ...(r.isError && { is_error: true }),
      })),
    };
  }
  if (m.raw?.provider === "anthropic") {
    return { role: "assistant", content: m.raw.data as Anthropic.ContentBlockParam[] };
  }
  return {
    role: "assistant",
    content: [
      ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
      ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })),
    ],
  };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────

/** OpenAI adapter (Chat Completions with function tools and JSON-schema output). */
export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";
  private client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI();
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const res = await this.client.chat.completions.create({
      model: req.model,
      max_completion_tokens: req.maxTokens,
      temperature: req.temperature,
      messages: [{ role: "system", content: req.system }, ...req.messages.flatMap(toOpenAI)],
      ...(req.tools && {
        tools: req.tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
      ...(req.jsonSchema && {
        response_format: {
          type: "json_schema" as const,
          json_schema: { name: "output", schema: req.jsonSchema },
        },
      }),
    });
    const message = res.choices[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).flatMap((c) =>
      c.type === "function" ? [{ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }] : [],
    );
    return {
      text: message?.content ?? "",
      model: res.model,
      ...(toolCalls.length && { toolCalls }),
      usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
    };
  }
}

function toOpenAI(m: ChatMessage): OpenAI.ChatCompletionMessageParam[] {
  if (m.role === "user") return [{ role: "user", content: m.content }];
  if (m.role === "tool") {
    return m.results.map((r) => ({ role: "tool" as const, tool_call_id: r.callId, content: r.content }));
  }
  return [
    {
      role: "assistant",
      content: m.content || null,
      ...(m.toolCalls?.length && {
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }),
    },
  ];
}

/** Malformed argument JSON is passed through as a string, so validation reports it to the model. */
function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

// ─── Google ───────────────────────────────────────────────────────────────

/** Google Gemini adapter (@google/genai). Replays model turns verbatim to keep thought signatures. */
export class GoogleProvider implements ModelProvider {
  readonly id = "google";
  private client: GoogleGenAI;

  constructor(client?: GoogleGenAI) {
    this.client = client ?? new GoogleGenAI({});
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const res = await this.client.models.generateContent({
      model: req.model,
      contents: req.messages.map(toGoogle),
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.tools && {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.inputSchema,
              })),
            },
          ],
        }),
        ...(req.jsonSchema && { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema }),
      },
    });
    const toolCalls: ToolCall[] = (res.functionCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name ?? "",
      args: c.args ?? {},
    }));
    const content = res.candidates?.[0]?.content;
    const text = (content?.parts ?? []).flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join("");
    return {
      text,
      model: req.model,
      ...(toolCalls.length && { toolCalls }),
      ...(content && { raw: { provider: "google", data: content } }),
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

function toGoogle(m: ChatMessage): Content {
  if (m.role === "user") return { role: "user", parts: [{ text: m.content }] };
  if (m.role === "tool") {
    return {
      role: "user",
      parts: m.results.map((r) => ({
        functionResponse: {
          id: r.callId,
          name: r.name,
          response: r.isError ? { error: r.content } : { output: r.content },
        },
      })),
    };
  }
  if (m.raw?.provider === "google") return m.raw.data as Content;
  return {
    role: "model",
    parts: [
      ...(m.content ? [{ text: m.content }] : []),
      ...(m.toolCalls ?? []).map((c) => ({
        functionCall: { id: c.id, name: c.name, args: c.args as Record<string, unknown> },
      })),
    ],
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────

/** Register every provider whose credentials are present in the environment. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider[] {
  const out: ModelProvider[] = [];
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    out.push(new AnthropicProvider(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, authToken: env.ANTHROPIC_AUTH_TOKEN })));
  }
  if (env.OPENAI_API_KEY) out.push(new OpenAIProvider(new OpenAI({ apiKey: env.OPENAI_API_KEY })));
  const googleKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (googleKey) out.push(new GoogleProvider(new GoogleGenAI({ apiKey: googleKey })));
  return out;
}
