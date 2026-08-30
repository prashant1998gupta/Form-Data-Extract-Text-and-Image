import "server-only";

/**
 * The database, and the app's posture when there isn't one.
 *
 * PERSISTENCE IS OPTIONAL, exactly as the reader is. With no Supabase
 * credentials the scanner still runs end to end — crops, reading, review —
 * and only the parts that need a database (publishing a form, saving a
 * record, the record views) say so plainly. That is not a hedge: it keeps the
 * demo runnable by anyone who clones this, and it means a database outage
 * degrades the product to what it was last week rather than to a stack trace.
 *
 * SERVER ONLY. The service role key would let a browser read every record of
 * every tenant, so it never leaves the server — `server-only` makes that a
 * build error rather than a code review. The publishable key is safe in a
 * browser but is not used there either: every read and write goes through a
 * route handler, so there is exactly one place where policy is enforced.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface DatabaseConfig {
  readonly url: string;
  readonly key: string;
}

/**
 * Credentials, or a stated reason there are none.
 *
 * The service role key is preferred where present — this server IS the trusted
 * tier, and it needs to read draft forms and write records that RLS
 * deliberately does not open to an anonymous browser.
 */
export function databaseConfig(env: Record<string, string | undefined> = process.env): DatabaseConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim();
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    env.SUPABASE_SECRET_KEY?.trim() ||
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) return null;
  return { url, key };
}

export function isDatabaseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return databaseConfig(env) !== null;
}

let cached: SupabaseClient | null = null;

/**
 * The shared client, or null when unconfigured.
 *
 * Cached because a serverless instance handles many requests and rebuilding
 * the client per request throws away its connection reuse for nothing.
 */
export function db(): SupabaseClient | null {
  if (cached) return cached;
  const config = databaseConfig();
  if (!config) return null;
  cached = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** The buckets, named once so a typo cannot split a record's evidence across two. */
export const BUCKETS = {
  /** The ORIGINAL capture, unmodified — the archived paper form. */
  captures: "captures",
  /** Extracted photograph, signature, thumb impression. */
  crops: "crops",
} as const;
