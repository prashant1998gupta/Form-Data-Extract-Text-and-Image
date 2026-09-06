/**
 * Which reader runs, decided from the server's environment — never from the
 * request. A capture must not be able to choose where it is sent.
 *
 *   READER_PROVIDER      openai | groq. Default: OpenAI when OPENAI_API_KEY is set, else Groq.
 *   OPENAI_API_KEY       enables the OpenAI reader (platform.openai.com, with credit on the account)
 *   OPENAI_MODEL         overrides the default GPT vision model
 *   OPENAI_BASE_URL      points at an OpenAI-compatible endpoint
 *   OPENAI_REASONING     none | minimal | low (default) | medium | high | default
 *   GROQ_API_KEY         enables the Groq reader (free tier at console.groq.com/keys)
 *   GROQ_MODEL           overrides the default vision model
 *   GROQ_BASE_URL        points at a Groq-compatible endpoint
 *   GROQ_REASONING       none (default) | low | medium | high | default
 *   READER_DOUBLE_CHECK  on | off. Read every scan twice and flag the fields the
 *                        two readings disagree on. On for OpenAI; off for Groq,
 *                        whose free tier cannot afford a second read a minute.
 *
 * With no key the reader is off, and the scan endpoint says so in words the
 * operator can act on rather than pretending the feature does not exist.
 */

import { groqProvider } from "./groq.ts";
import { openaiProvider } from "./openai.ts";
import { ProviderError, REASONING_EFFORTS, type ReadRequest, type ReasoningEffort, type TextProvider } from "./provider-types.ts";

export interface ResolvedReader {
  readonly provider: TextProvider | null;
  /** Why there is no provider, phrased for a log line. Present iff `provider` is null. */
  readonly reason?: string;
}

export function resolveReader(env: Record<string, string | undefined>): ResolvedReader {
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const groqKey = env.GROQ_API_KEY?.trim();
  const wanted = env.READER_PROVIDER?.trim().toLowerCase();
  const provider = wanted === "groq" || wanted === "openai" ? wanted : openaiKey ? "openai" : "groq";

  if (provider === "openai") {
    if (!openaiKey) return { provider: null, reason: "READER_PROVIDER is openai but OPENAI_API_KEY is not set" };
    return {
      provider: openaiProvider({
        apiKey: openaiKey,
        model: env.OPENAI_MODEL?.trim() || undefined,
        baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
        reasoning: reasoningEffort(env.OPENAI_REASONING, "low"),
      }),
    };
  }
  if (!groqKey) {
    return { provider: null, reason: wanted === "groq" ? "READER_PROVIDER is groq but GROQ_API_KEY is not set" : "neither OPENAI_API_KEY nor GROQ_API_KEY is set" };
  }
  return {
    provider: groqProvider({
      apiKey: groqKey,
      model: env.GROQ_MODEL?.trim() || undefined,
      baseUrl: env.GROQ_BASE_URL?.trim() || undefined,
      reasoning: reasoningEffort(env.GROQ_REASONING),
    }),
  };
}

/**
 * Whether every scan is read twice, the two readings compared, and the
 * fields they disagree on flagged for a look. It turns a confident wrong
 * name into a "check this", which is what an operator needs from a reader
 * that never says "I could not read that". Costs a second call per scan.
 */
export function doubleCheckWanted(env: Record<string, string | undefined>, provider: TextProvider): boolean {
  const raw = env.READER_DOUBLE_CHECK?.trim().toLowerCase();
  if (raw === "on" || raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "off" || raw === "0" || raw === "false" || raw === "no") return false;
  return provider.name === "openai";
}

/** The environment's word for how much thinking is allowed; the fallback for anything unrecognised. */
export function reasoningEffort(raw: string | undefined, fallback: ReasoningEffort = DEFAULT_REASONING): ReasoningEffort {
  const value = raw?.trim();
  return (REASONING_EFFORTS as readonly string[]).includes(value ?? "") ? (value as ReasoningEffort) : fallback;
}

/**
 * Groq's default: off. Thinking was tried there for a hurried Devanagari hand
 * and did not read it better — the names came back invented either way —
 * while every thought counts as output against the free tier's per-minute
 * cap. OpenAI's default is set where its reader is built.
 */
const DEFAULT_REASONING: ReasoningEffort = "none";

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
