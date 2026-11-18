import type { GenerateRequest, GenerateResponse, ModelProvider, ToolCall } from "@saddlebags/sdk";

/** Return a string for a plain text reply, or an object to request tool calls. */
export type MockResponder = (
  req: GenerateRequest,
  call: number,
) => string | { text?: string; toolCalls: ToolCall[] };

/** A scripted provider for tests and evals in CI. Records every request. */
export class MockProvider implements ModelProvider {
  readonly calls: GenerateRequest[] = [];

  constructor(
    readonly id: string,
    private respond: MockResponder,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    // Snapshot the messages: the harness keeps appending to the same array.
    this.calls.push({ ...req, messages: [...req.messages] });
    const r = this.respond(req, this.calls.length - 1);
    return typeof r === "string"
      ? { text: r, model: req.model }
      : { text: r.text ?? "", toolCalls: r.toolCalls, model: req.model };
  }
}
