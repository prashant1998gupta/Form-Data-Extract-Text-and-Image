/**
 * The OpenAI client.
 *
 * The same OpenAI-shaped endpoint as Groq's, with the differences that make
 * a request fail there: reasoning models take `max_completion_tokens` and
 * no `temperature`, thinking is asked for with `reasoning_effort`, and an
 * image is sent at `detail: "high"` so the model sees the handwriting at
 * the resolution it was sent in. The default model is a small GPT-5 for
 * cost; `OPENAI_MODEL` changes it without a deploy touching this file, and
 * `OPENAI_BASE_URL` points the client at a compatible endpoint.
 */

import { finishReason, messageContent, refusalDetail, retryAfterMs } from "./chat-completions.ts";
import { ProviderError, type ReadRequest, type ReasoningEffort, type TextProvider } from "./provider-types.ts";

export const OPENAI_DEFAULT_MODEL = "gpt-5.4-mini";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** Room for thinking AND the reply: on a reasoning model both come out of one budget. */
const DEFAULT_MAX_COMPLETION_TOKENS = 8000;

export interface OpenAIOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /**
   * How much the model may think before answering. A little by default: a
   * hurried hand rewards a second look, and "low" costs seconds, not
   * minutes. "default" leaves the model to its own setting.
   */
  readonly reasoning?: ReasoningEffort;
  /** Injection point for tests. Defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * GPT-5 and the o-series think; they refuse `temperature` and want
 * `max_completion_tokens`. The "-chat" variants of GPT-5 do not think and
 * refuse `reasoning_effort` instead.
 */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model) && !/-chat/.test(model);
}

/**
 * The effort word each family takes. The first GPT-5 (no point in its name)
 * and the o-series have "minimal" and no "none"; GPT-5.1 and later have
 * "none" and "xhigh" and no "minimal"; the o-series has neither end.
 */
export function openaiEffort(model: string, effort: ReasoningEffort): string {
  const oSeries = /^o\d/.test(model);
  const firstGpt5 = /^gpt-5(-|$)/.test(model);
  if (oSeries) {
    if (effort === "none" || effort === "minimal") return "low";
    if (effort === "xhigh") return "high";
    return effort;
  }
  if (firstGpt5) {
    if (effort === "none") return "minimal";
    if (effort === "xhigh") return "high";
    return effort;
  }
  return effort === "minimal" ? "none" : effort;
}

export function openaiProvider(options: OpenAIOptions): TextProvider {
  const model = options.model ?? OPENAI_DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const reasoning = options.reasoning ?? "low";

  return {
    name: "openai",
    model,
    async read(request: ReadRequest): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          {
            role: "user",
            content: [
              ...request.imagesJpegBase64.map((jpeg) => ({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${jpeg}`, detail: "high" },
              })),
              { type: "text", text: request.prompt },
            ],
          },
        ],
      };
      if (isReasoningModel(model)) {
        body.max_completion_tokens = request.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
        if (reasoning !== "default") body.reasoning_effort = openaiEffort(model, reasoning);
      } else {
        body.max_tokens = request.maxTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
        body.temperature = 0;
      }

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "TimeoutError") {
          throw new ProviderError("the reader timed out", { retryable: false });
        }
        throw new ProviderError("the reader could not be reached", { retryable: false, cause });
      }

      if (!response.ok) {
        const detail = await refusalDetail(response);
        // OpenAI's account-empty answer: type "insufficient_quota" (the code beside it has varied).
        const noCredit = response.status === 429 && (detail.type === "insufficient_quota" || detail.code === "insufficient_quota" || detail.code === "credit_balance_exhausted");
        if (response.status === 429 && !noCredit) console.warn(`openai rate limit: ${detail.message ?? "(no detail)"}; retry-after ${response.headers.get("retry-after") ?? "?"}`);
        throw new ProviderError(statusMessage(response.status, detail.message, noCredit), {
          status: response.status,
          retryable: (response.status === 429 && !noCredit) || response.status >= 500,
          retryAfterMs: retryAfterMs(response),
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError("the reader's reply could not be read", { retryable: false });
      }
      if (finishReason(payload) === "length") {
        throw new ProviderError("the reader ran out of room before answering", { retryable: false });
      }
      const content = messageContent(payload);
      if (content === null) {
        throw new ProviderError("the reader's reply carried no text", { retryable: false });
      }
      return content;
    },
  };
}

function statusMessage(status: number, message: string | null, noCredit: boolean): string {
  if (noCredit) return "the OpenAI account has no credit — add credits at platform.openai.com/settings/organization/billing";
  if (status === 401 || status === 403) return "the OpenAI API key was refused — check OPENAI_API_KEY";
  if (status === 404) return "the OpenAI model was not found — set OPENAI_MODEL to one this key can use";
  if (status === 413) return "the page image was too large for the reader";
  if (status === 429) return "the reader is busy right now — wait a moment and try again";
  if (status >= 500) return "the reader had a server error";
  return message ? `the reader refused the request (HTTP ${status}: ${message})` : `the reader refused the request (HTTP ${status})`;
}
