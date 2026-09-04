/**
 * The reader contract, kept apart from the Groq client so a test can fake a
 * provider without a network.
 */

export interface ReadRequest {
  /** The page image, JPEG, base64 without a data-URL prefix. */
  readonly imageJpegBase64: string;
  /** The rules — the same for every form. */
  readonly system: string;
  /** The form's field list and the reply shape. */
  readonly prompt: string;
  readonly timeoutMs: number;
  /**
   * Room for the reply. Generous by default: a school form's reply carries
   * fifty values, some paragraph-length, and a cap that truncates mid-JSON
   * fails the whole scan as a format violation.
   */
  readonly maxTokens?: number;
}

export interface TextProvider {
  readonly name: "groq";
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
