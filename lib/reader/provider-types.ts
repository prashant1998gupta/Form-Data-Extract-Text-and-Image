/**
 * The provider contract, kept apart from the provider registry so a test can
 * import a single provider (or fake one) without pulling every SDK the
 * registry knows about into the process.
 */

export interface ReadRequest {
  /** The evidence crop, JPEG, base64 without a data-URL prefix. */
  readonly imageJpegBase64: string;
  /** The shared transcription contract — `READER_SYSTEM_PROMPT`. */
  readonly system: string;
  /** The per-field instruction. */
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface TextProvider {
  readonly name: "groq" | "anthropic";
  readonly model: string;
  /** Returns the model's raw reply text. Throws `ProviderError` on transport failure. */
  read(request: ReadRequest): Promise<string>;
}

/**
 * A transport-level failure, phrased for the operator.
 *
 * `retryable` marks faults where one more attempt is worth one more attempt —
 * rate limits and server errors — and nothing else: retrying a refused API key
 * is asking the same question louder.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; retryable: boolean; retryAfterMs?: number; cause?: unknown } = { retryable: false },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
