/**
 * The Groq client.
 *
 * Groq serves open vision models over an OpenAI-shaped REST endpoint; a raw
 * fetch is the whole integration and adds no dependency. The default model is
 * `qwen/qwen3.6-27b`: Groq serves two Qwen vision models — both Llama 4
 * vision models were retired in 2026 — and the newer `qwen/qwen3.8-27b` is
 * capped on the free tier at 1,000 output tokens a minute, under one school
 * form's reply, so every request to it is refused before it runs. It read
 * no better on a Hindi hand where it did run. `GROQ_MODEL` changes the model
 * without a deploy touching this file. `GROQ_BASE_URL` points the client at a
 * compatible endpoint (a proxy, or a local stand-in while developing).
 *
 * JSON mode (`response_format: {type: "json_object"}`) is supported with
 * vision input and makes the fenced-markdown reply rare; `parse.ts` treats
 * the reply as untrusted either way.
 */

import { finishReason, messageContent, refusalDetail, retryAfterMs } from "./chat-completions.ts";
import { ProviderError, type ReadRequest, type ReasoningEffort, type TextProvider } from "./provider-types.ts";

export const GROQ_DEFAULT_MODEL = "qwen/qwen3.6-27b";
export const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";


export interface GroqOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  /**
   * How much the model may "think" before answering. Off by default: a
   * transcription has nothing to deliberate, and a reasoning model that
   * thinks in JSON mode can spend the entire output budget on thoughts and
   * hand Groq an empty reply — which Groq then refuses as invalid JSON. The
   * graded levels exist for the models that take them (qwen3.8 does); note
   * that thinking counts as output, against the free tier's per-minute cap.
   */
  readonly reasoning?: ReasoningEffort;
  /** Injection point for tests. Defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function groqProvider(options: GroqOptions): TextProvider {
  const model = options.model ?? GROQ_DEFAULT_MODEL;
  const baseUrl = (options.baseUrl ?? GROQ_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "groq",
    model,
    async read(request: ReadRequest): Promise<string> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            // Deterministic-as-available: transcription has one right answer.
            temperature: 0,
            max_tokens: request.maxTokens ?? 4096,
            reasoning_effort: groqEffort(options.reasoning ?? "none"),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              {
                role: "user",
                content: [
                  ...request.imagesJpegBase64.map((jpeg) => ({
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${jpeg}` },
                  })),
                  { type: "text", text: request.prompt },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "TimeoutError") {
          throw new ProviderError("the reader timed out", { retryable: false });
        }
        throw new ProviderError("the reader could not be reached", { retryable: false, cause });
      }

      if (!response.ok) {
        const refusal = await describeRefusal(response);
        // A rate limit is the operator's problem, and Groq's message says
        // which limit — per minute, per day, tokens or requests.
        if (response.status === 429) console.warn(`groq rate limit: ${refusal ?? "(no detail)"}; retry-after ${response.headers.get("retry-after") ?? "?"}`);
        throw new ProviderError(statusMessage(response.status, refusal), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: retryAfterMs(response),
        });
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ProviderError("the reader's reply could not be read", { retryable: false });
      }

      // Truncation is named as what it is. Without this branch a reply cut
      // mid-JSON surfaces as "not in the agreed format" — a budget problem
      // misreported as a model contract violation.
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

/**
 * Groq's own account of a refusal, when it gives one. A 400 in JSON mode
 * usually means the model's reply failed JSON validation; Groq then sends
 * the failed reply back as `failed_generation`, which is logged for the
 * operator and never shown to the person.
 */
async function describeRefusal(response: Response): Promise<string | null> {
  const detail = await refusalDetail(response);
  if (detail.failedGeneration !== null) {
    // One escaped line: a multi-line value is cut to its first line by
    // most log viewers, which for a JSON reply is a lone brace.
    console.error(`groq rejected the model's reply as JSON: ${JSON.stringify(detail.failedGeneration.slice(0, 2000))}`);
  }
  if (detail.message) return detail.code ? `${detail.message} [${detail.code}]` : detail.message;
  const trimmed = detail.text.trim().slice(0, 200);
  return trimmed || null;
}

/** Groq's vocabulary has neither "minimal" nor "xhigh"; the nearest it has. */
function groqEffort(effort: ReasoningEffort): "none" | "low" | "medium" | "high" | "default" {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "high";
  return effort;
}

function statusMessage(status: number, refusal: string | null): string {
  if (status === 401 || status === 403) return "the Groq API key was refused — check GROQ_API_KEY";
  if (status === 404) return "the Groq model was not found — it may have been retired; set GROQ_MODEL";
  if (status === 413) return "the page image was too large for the reader";
  if (status === 429) return "the reader is busy right now — wait a moment and try again";
  if (status >= 500) return "the reader had a server error";
  return refusal ? `the reader refused the request (HTTP ${status}: ${refusal})` : `the reader refused the request (HTTP ${status})`;
}
