/**
 * Which reader runs, decided from the server's environment — never from the
 * request. A capture must not be able to choose where it is sent.
 *
 *   GROQ_API_KEY   enables reading (free tier at console.groq.com/keys)
 *   GROQ_MODEL     overrides the default vision model
 *   GROQ_BASE_URL  points at a Groq-compatible endpoint
 *   GROQ_REASONING "default" lets a reasoning model think first; off otherwise
 *
 * With no key the reader is off, and the scan endpoint says so in words the
 * operator can act on rather than pretending the feature does not exist.
 */

import { groqProvider } from "./groq.ts";
import { ProviderError, type ReadRequest, type TextProvider } from "./provider-types.ts";

export interface ResolvedReader {
  readonly provider: TextProvider | null;
  /** Why there is no provider, phrased for a log line. Present iff `provider` is null. */
  readonly reason?: string;
}

export function resolveReader(env: Record<string, string | undefined>): ResolvedReader {
  const apiKey = env.GROQ_API_KEY?.trim();
  if (!apiKey) return { provider: null, reason: "GROQ_API_KEY is not set" };
  return {
    provider: groqProvider({
      apiKey,
      model: env.GROQ_MODEL?.trim() || undefined,
      baseUrl: env.GROQ_BASE_URL?.trim() || undefined,
      reasoning: env.GROQ_REASONING?.trim() === "default" ? "default" : "none",
    }),
  };
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  readonly attempts?: number;
  /** The longest single wait honoured, so a retry-after of 30 s cannot outlive the request budget. */
  readonly maxWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * One more attempt on a retryable fault, after the wait the server asked for.
 *
 * Groq's free tier answers a burst with 429 and a retry-after of a few
 * seconds; without this, the first scan after a busy minute fails for no
 * reason the person holding the paper can do anything about.
 */
export async function readWithRetry(provider: TextProvider, request: ReadRequest, options: RetryOptions = {}): Promise<string> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await provider.read(request);
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ProviderError && error.retryable;
      if (!retryable || attempt === attempts) break;
      const wait = Math.min(maxWaitMs, error.retryAfterMs ?? 2_000);
      await sleep(wait);
    }
  }
  throw lastError;
}
