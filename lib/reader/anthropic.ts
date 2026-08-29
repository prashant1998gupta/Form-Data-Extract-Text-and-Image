/**
 * The Anthropic provider — Claude, through the official SDK.
 *
 * Claude is the quality option for handwriting: the default model is
 * `claude-opus-5`, overridable with `FORMLINK_TEXT_MODEL`. Two deliberate
 * request choices:
 *
 * - `output_config.effort: "low"`. Transcribing one short crop is perception,
 *   not reasoning; low effort answers the same and keeps eight parallel calls
 *   cheap and quick. Thinking stays on (adaptive is the model's default) —
 *   explicitly disabling it is the configuration Anthropic documents as
 *   failure-prone.
 * - Server-side refusal fallbacks (`fallbacks: "default"` with the
 *   `server-side-fallback-2026-07-01` beta). If a safety classifier declines a
 *   crop, the API re-runs it on a fallback model inside the same call instead
 *   of the field silently reading as a fault. A refusal that survives the
 *   whole chain is reported as this field's failure, in words, with no number.
 */

import Anthropic from "@anthropic-ai/sdk";

import { ProviderError, type ReadRequest, type TextProvider } from "./provider-types.ts";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly model?: string;
}

export function anthropicProvider(options: AnthropicOptions): TextProvider {
  const model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
  // maxRetries: 0 is load-bearing. The SDK's default is 2, its per-request
  // `timeout` is per ATTEMPT, and its 429 handling honours retry-after with no
  // cap — so left on, one hung field could spend ~3x its 30 s budget inside a
  // single create() call and blow the route's 60 s ceiling on its own, and a
  // rate limit would be hit six times per field instead of twice. Retry policy
  // belongs to `callWithOneRetry` in read-text-fields.ts, and only there.
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });

  return {
    name: "anthropic",
    model,
    // Anthropic's limits fit per-field requests comfortably, so the mode with
    // the structurally unmisattributable value→field mapping stays default.
    preferredMode: "perField",
    async read(request: ReadRequest): Promise<string> {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create(
          {
            model,
            // The reply is a one-line JSON object; nearly all of this budget
            // exists to absorb adaptive thinking, which counts against
            // max_tokens on this model and spends most on exactly the hard,
            // ambiguous crops this feature is for. Too small a budget turns
            // "thought hard" into a truncation misreported as a fault.
            max_tokens: 8192,
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: "default",
            output_config: { effort: "low" },
            system: request.system,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: request.imageJpegBase64 },
                  },
                  { type: "text", text: request.prompt },
                ],
              },
            ],
          },
          { timeout: request.timeoutMs },
        );
      } catch (error) {
        throw asProviderError(error);
      }

      if (response.stop_reason === "refusal") {
        // The whole fallback chain declined. There is nothing to parse and no
        // number to attach — the operator reads the paper themselves.
        throw new ProviderError("the reader declined to read this crop", { retryable: false });
      }
      if (response.stop_reason === "max_tokens") {
        // Cut off before (or mid-) answer. Named as what it is rather than
        // falling through to "carried no text" / "not in the agreed format",
        // both of which would misreport a budget truncation as a fault.
        throw new ProviderError("the reader ran out of room before answering", { retryable: false });
      }

      const text = response.content
        .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      if (text.trim() === "") {
        throw new ProviderError("the reader's reply carried no text", { retryable: false });
      }
      return text;
    },
  };
}

function asProviderError(error: unknown): ProviderError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError("the Anthropic API key was refused — check ANTHROPIC_API_KEY", {
      status: error.status,
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError("the reader is rate limited — try again in a moment", {
      status: error.status,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ProviderError("the Anthropic model was not found — check FORMLINK_TEXT_MODEL", {
      status: error.status,
      retryable: false,
      cause: error,
    });
  }
  // Connection errors extend APIError in this SDK, so they must be named
  // before the generic branch or a dropped connection reads as a refusal.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("the reader timed out", { retryable: false, cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("the reader could not be reached", { retryable: false, cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    return new ProviderError(
      status !== undefined && status >= 500 ? "the reader had a server error" : "the reader refused the request",
      { status, retryable: status !== undefined && status >= 500, cause: error },
    );
  }
  return new ProviderError("the reader failed unexpectedly", { retryable: false, cause: error });
}
