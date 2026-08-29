/**
 * The Groq provider.
 *
 * Groq serves open models over an OpenAI-shaped REST endpoint; a raw fetch is
 * the whole integration and adds no dependency. The default model is
 * `qwen/qwen3.6-27b` because it is what Groq actually serves for vision today:
 * both Llama 4 vision models were deprecated in early 2026 (Maverick shut down
 * 2026-03-09, Scout 2026-07-17), and the Qwen multimodal models are their
 * documented replacement. When Groq rotates models again, `FORMLINK_TEXT_MODEL`
 * changes the model without a deploy touching this file.
 *
 * JSON mode (`response_format: {type: "json_object"}`) is supported with
 * vision input on these models and makes the fenced-markdown reply path rare;
 * `parse.ts` still treats the reply as untrusted either way.
 */

import { ProviderError, type ReadRequest, type TextProvider } from "./provider-types.ts";

export const GROQ_DEFAULT_MODEL = "qwen/qwen3.6-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface GroqOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Injection point for tests. Defaults to the platform fetch. */
  readonly fetchImpl?: typeof fetch;
}

export function groqProvider(options: GroqOptions): TextProvider {
  const model = options.model ?? GROQ_DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    name: "groq",
    model,
    // Groq prices every image at a flat ~2k input tokens and its free tier
    // caps tokens per minute below one scan's worth of per-field requests —
    // eight requests can never finish, one composite always can.
    preferredMode: "composite",
    async read(request: ReadRequest): Promise<string> {
      let response: Response;
      try {
        response = await fetchImpl(GROQ_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            // Deterministic-as-available: transcription has one right answer.
            temperature: 0,
            // Generous on purpose: a composite reply carries up to 40 fields'
            // transcriptions, some legitimately paragraph-length, and output
            // tokens only cost when generated — while a cap that truncates
            // mid-JSON fails the WHOLE scan as a format violation. Cheap
            // insurance against an expensive misdiagnosis.
            max_tokens: 4096,
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
        throw new ProviderError(statusMessage(response.status), {
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
      // misreported as a model contract violation, unretried and unactionable.
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

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "the Groq API key was refused — check GROQ_API_KEY";
  if (status === 404) return "the Groq model was not found — it may have been deprecated; set FORMLINK_TEXT_MODEL";
  if (status === 413) return "the crop was too large for the reader";
  if (status === 429) return "the reader is rate limited — try again in a moment";
  if (status >= 500) return "the reader had a server error";
  return `the reader refused the request (HTTP ${status})`;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 10) * 1000 : undefined;
}
