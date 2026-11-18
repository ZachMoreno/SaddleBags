import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { GenerateRequest, GenerateResponse, ModelProvider } from "@saddlebags/sdk";

/**
 * Anthropic adapter. Uses structured outputs (`output_config.format`) when the
 * route is typed. Sampling params are not sent: current Claude models reject them.
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
      messages: req.messages,
      ...(req.jsonSchema && { output_config: { format: { type: "json_schema", schema: req.jsonSchema } } }),
    });
    if (res.stop_reason === "refusal") {
      throw new Error(`Model refused: ${res.stop_details?.explanation ?? "no explanation"}`);
    }
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      text,
      model: res.model,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }
}

/** OpenAI adapter (Chat Completions with JSON-schema response format). */
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
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.jsonSchema && {
        response_format: {
          type: "json_schema" as const,
          json_schema: { name: "output", schema: req.jsonSchema },
        },
      }),
    });
    return {
      text: res.choices[0]?.message.content ?? "",
      model: res.model,
      usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
    };
  }
}

/** Google Gemini adapter (@google/genai). */
export class GoogleProvider implements ModelProvider {
  readonly id = "google";
  private client: GoogleGenAI;

  constructor(client?: GoogleGenAI) {
    this.client = client ?? new GoogleGenAI({});
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const res = await this.client.models.generateContent({
      model: req.model,
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: req.system,
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.jsonSchema && { responseMimeType: "application/json", responseJsonSchema: req.jsonSchema }),
      },
    });
    return {
      text: res.text ?? "",
      model: req.model,
      usage: {
        inputTokens: res.usageMetadata?.promptTokenCount,
        outputTokens: res.usageMetadata?.candidatesTokenCount,
      },
    };
  }
}

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
