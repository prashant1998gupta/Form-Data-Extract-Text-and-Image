/**
 * Which reader runs, decided from the server's environment — never from the
 * request. A capture must not be able to choose where it is sent.
 *
 *   GROQ_API_KEY            enables Groq   (free tier at console.groq.com/keys)
 *   ANTHROPIC_API_KEY       enables Claude (console.anthropic.com)
 *   FORMLINK_TEXT_PROVIDER  "groq" | "anthropic" — forces one when both keys exist
 *   FORMLINK_TEXT_MODEL     overrides the provider's default model
 *
 * With both keys present and no preference stated, Claude wins: on the
 * evidence of real handwriting it is the more accurate reader, and accuracy is
 * the entire point of paying per call. With no key at all the reader is simply
 * off, and extraction behaves exactly as it did before the reader existed —
 * that degradation is a product feature, not an error state.
 */

import { anthropicProvider } from "./anthropic.ts";
import { groqProvider } from "./groq.ts";
import type { TextProvider } from "./provider-types.ts";

export interface ResolvedReader {
  readonly provider: TextProvider | null;
  /** Why there is no provider, phrased for a log line. Present iff `provider` is null. */
  readonly reason?: string;
  /**
   * True when the environment STATES a preference it then breaks — a forced
   * provider whose key is missing, or an unknown provider name. Distinct from
   * plain "no key" because the honest screen message is different: telling an
   * operator who typo'd FORMLINK_TEXT_PROVIDER that "no AI key is configured"
   * sends them to re-add a key that is already there.
   */
  readonly misconfigured?: boolean;
}

export function resolveReader(env: Record<string, string | undefined>): ResolvedReader {
  const forced = env.FORMLINK_TEXT_PROVIDER?.trim().toLowerCase();
  const model = env.FORMLINK_TEXT_MODEL?.trim() || undefined;
  const groqKey = env.GROQ_API_KEY?.trim();
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();

  if (forced === "groq") {
    if (!groqKey) {
      return { provider: null, misconfigured: true, reason: "FORMLINK_TEXT_PROVIDER is groq but GROQ_API_KEY is not set" };
    }
    return { provider: groqProvider({ apiKey: groqKey, model }) };
  }
  if (forced === "anthropic") {
    if (!anthropicKey) {
      return {
        provider: null,
        misconfigured: true,
        reason: "FORMLINK_TEXT_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set",
      };
    }
    return { provider: anthropicProvider({ apiKey: anthropicKey, model }) };
  }
  if (forced) {
    return { provider: null, misconfigured: true, reason: `FORMLINK_TEXT_PROVIDER names an unknown provider "${forced}"` };
  }

  if (anthropicKey) return { provider: anthropicProvider({ apiKey: anthropicKey, model }) };
  if (groqKey) return { provider: groqProvider({ apiKey: groqKey, model }) };

  return { provider: null, reason: "no reader API key is configured" };
}
