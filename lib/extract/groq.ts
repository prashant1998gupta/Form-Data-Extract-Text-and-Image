/**
 * The Groq client.
 *
 * Groq serves open vision models over an OpenAI-shaped REST endpoint; a raw
 * fetch is the whole integration and adds no dependency. The default model is
 * `qwen/qwen3.6-27b` because it is what Groq serves for vision today — both
 * Llama 4 vision models were retired in 2026 — and `GROQ_MODEL` changes it
 * without a deploy touching this file. `GROQ_BASE_URL` points the client at a
 * compatible endpoint (a proxy, or a local stand-in while developing).
 *
 * JSON mode (`response_format: {type: "json_object"}`) is supported with
 * vision input and makes the fenced-markdown reply rare; `parse.ts` treats
 * the reply as untrusted either way.
 */

import { ProviderError, type ReadRequest, type TextProvider } from "./provider-types.ts";

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
   * hand Groq an empty reply — which Groq then refuses as invalid JSON.
   */
  readonly reasoning?: "none" | "default";
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
            reasoning_effort: options.reasoning ?? "none",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: request.system },
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${request.imageJpegBase64}` },
                  },
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

/** `choices[0].message.content`, verified rather than cast. */
function messageContent(payload: unknown): string | null {
  const message = firstChoice(payload)?.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function finishReason(payload: unknown): string | null {
  const reason = firstChoice(payload)?.finish_reason;
  return typeof reason === "string" ? reason : null;
}

function firstChoice(payload: unknown): { message?: unknown; finish_reason?: unknown } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  return typeof choice === "object" && choice !== null ? (choice as { message?: unknown; finish_reason?: unknown }) : null;
}

/**
 * Groq's own account of a refusal, when it gives one. A 400 in JSON mode
 * usually means the model's reply failed JSON validation; Groq then sends
 * the failed reply back as `failed_generation`, which is logged for the
 * operator and never shown to the person.
 */
async function describeRefusal(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; failed_generation?: unknown } };
    const error = payload.error;
    if (error && typeof error === "object") {
      if (typeof error.failed_generation === "string") {
        // One escaped line: a multi-line value is cut to its first line by
        // most log viewers, which for a JSON reply is a lone brace.
        console.error(`groq rejected the model's reply as JSON: ${JSON.stringify(error.failed_generation.slice(0, 2000))}`);
      }
      if (typeof error.message === "string") {
        return typeof error.code === "string" ? `${error.message} [${error.code}]` : error.message;
      }
    }
  } catch {
    // Not JSON — the text itself is the account.
  }
  const trimmed = text.trim().slice(0, 200);
  return trimmed || null;
}

function statusMessage(status: number, refusal: string | null): string {
  if (status === 401 || status === 403) return "the Groq API key was refused — check GROQ_API_KEY";
  if (status === 404) return "the Groq model was not found — it may have been retired; set GROQ_MODEL";
  if (status === 413) return "the page image was too large for the reader";
  if (status === 429) return "the reader is busy right now — wait a moment and try again";
  if (status >= 500) return "the reader had a server error";
  return refusal ? `the reader refused the request (HTTP ${status}: ${refusal})` : `the reader refused the request (HTTP ${status})`;
}

/**
 * How long the server asked us to wait, when it said. Groq's free tier answers
 * a burst with `retry-after` values of 2-20 s; the cap keeps a misbehaving
 * header from parking a request for a minute.
 */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : undefined;
}
