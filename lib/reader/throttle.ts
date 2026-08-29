/**
 * A per-instance ceiling on how many scans may reach a paid model per minute.
 *
 * WHAT THIS IS. `/api/extract` has no authentication — nothing in this app
 * does yet — and the reader turned an anonymous POST from "costs us 60 s of
 * CPU" into "costs us a scan's worth of metered vision calls" (one composite
 * request, or one per field, by mode). Anyone can fetch the bundled sample
 * form from the deployment itself and loop it. This bound
 * converts unlimited spend per instance into a stated number per minute, and
 * refuses the excess in words the operator sees.
 *
 * WHAT THIS IS NOT. It is not authentication and it does not pretend to be:
 * the counter lives in module scope, so every serverless instance has its own,
 * and a determined attacker who can fan out across instances multiplies the
 * ceiling by the instance count. The real fix is the auth the product roadmap
 * already owes; until then the honest protections are this bound, a spend cap
 * set with the provider, and not putting a key on a public deployment at all —
 * the README says all three.
 *
 * Sliding window rather than a token bucket because the claim it enforces is
 * exactly "at most N scans in any 60 s", which is the sentence an operator can
 * check against their provider dashboard.
 */

const WINDOW_MS = 60_000;
export const DEFAULT_SCANS_PER_MINUTE = 10;

/** Start times of reader scans in the last window, oldest first. */
let starts: number[] = [];

export interface ThrottleOptions {
  /** Scans allowed per minute. 0 disables the bound entirely. */
  readonly scansPerMinute: number;
  readonly now?: number;
}

/**
 * Records one scan against the window and says whether it may read.
 *
 * Counting BEFORE asking is deliberate: a refused scan still occupies its slot,
 * so a flood of requests cannot probe the window's edge for free.
 */
export function admitReaderScan(options: ThrottleOptions): boolean {
  if (options.scansPerMinute <= 0) return true;
  const now = options.now ?? Date.now();
  starts = starts.filter((started) => now - started < WINDOW_MS);
  if (starts.length >= options.scansPerMinute) return false;
  starts.push(now);
  return true;
}

/** How many scans per minute the environment allows. */
export function scansPerMinute(env: Record<string, string | undefined>): number {
  const raw = env.FORMLINK_TEXT_MAX_SCANS_PER_MINUTE?.trim();
  if (!raw) return DEFAULT_SCANS_PER_MINUTE;
  const parsed = Number(raw);
  // A malformed value falls back to the default rather than to "unlimited":
  // failing open on a spend bound because of a typo would be the wrong default.
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCANS_PER_MINUTE;
  return Math.floor(parsed);
}

/** Test hook. Nothing in the app calls this. */
export function resetReaderThrottle(): void {
  starts = [];
}
