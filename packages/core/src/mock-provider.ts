import type { GenerateRequest, GenerateResponse, ModelProvider } from "@saddlebags/sdk";

export type MockResponder = (req: GenerateRequest, call: number) => string;

/** A scripted provider for tests and evals in CI. Records every request. */
export class MockProvider implements ModelProvider {
  readonly calls: GenerateRequest[] = [];

  constructor(
    readonly id: string,
    private respond: MockResponder,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.calls.push(req);
    return { text: this.respond(req, this.calls.length - 1), model: req.model };
  }
}
