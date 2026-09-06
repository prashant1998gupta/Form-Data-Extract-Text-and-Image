/**
 * What the two OpenAI-shaped chat endpoints have in common on the way back:
 * the reply's text, its finish reason, and the wait a 429 asks for. Each
 * client keeps its own words for refusals, because the fixes differ.
 */

/** `choices[0].message.content`, verified rather than cast. */
export function messageContent(payload: unknown): string | null {
  const message = firstChoice(payload)?.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

export function finishReason(payload: unknown): string | null {
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
 * How long the server asked us to wait, when it said. Free tiers answer a
 * burst with `retry-after` values of 2-20 s; the cap keeps a misbehaving
 * header from parking a request for a minute.
 */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 30) * 1000 : undefined;
}

/** The `error` object an OpenAI-shaped endpoint sends with a refusal, when it does. */
export interface RefusalDetail {
  readonly message: string | null;
  readonly code: string | null;
  readonly type: string | null;
  readonly failedGeneration: string | null;
  readonly text: string;
}

export async function refusalDetail(response: Response): Promise<RefusalDetail> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { message: null, code: null, type: null, failedGeneration: null, text: "" };
  }
  try {
    const payload = JSON.parse(text) as { error?: { message?: unknown; code?: unknown; type?: unknown; failed_generation?: unknown } };
    const error = payload.error;
    if (error && typeof error === "object") {
      return {
        message: typeof error.message === "string" ? error.message : null,
        code: typeof error.code === "string" ? error.code : null,
        type: typeof error.type === "string" ? error.type : null,
        failedGeneration: typeof error.failed_generation === "string" ? error.failed_generation : null,
        text,
      };
    }
  } catch {
    // Not JSON — the text itself is the account.
  }
  return { message: null, code: null, type: null, failedGeneration: null, text };
}
