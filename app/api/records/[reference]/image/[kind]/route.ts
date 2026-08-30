import "server-only";

import { BUCKETS, db, isDatabaseConfigured } from "@/lib/db/client";
import { recordByReference } from "@/lib/db/records";

export const runtime = "nodejs";

/**
 * A record's images, served BY THIS APPLICATION rather than by storage links.
 *
 * The alternative — minting a signed storage URL and putting it in the page —
 * hands the browser a bearer token for a patient's photograph that keeps
 * working after they close the tab, can be pasted into a chat, and is indexed
 * by whatever the page is later shared with. Streaming through here means the
 * token never leaves the server, the URL is meaningless to anyone who cannot
 * already read the record, and there is exactly one place to add an
 * authorization check when accounts land.
 *
 * The four kinds are a closed set: the path cannot address arbitrary objects
 * in a bucket, only the four images this record declares.
 */
const KINDS = ["photo", "signature", "thumb", "original"] as const;
type Kind = (typeof KINDS)[number];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reference: string; kind: string }> },
): Promise<Response> {
  const { reference, kind } = await params;

  if (!isDatabaseConfigured()) return new Response("Not found", { status: 404 });
  if (!(KINDS as readonly string[]).includes(kind)) return new Response("Not found", { status: 404 });

  const record = await recordByReference(reference);
  if (!record) return new Response("Not found", { status: 404 });

  const path =
    kind === "photo"
      ? record.photoPath
      : kind === "signature"
        ? record.signaturePath
        : kind === "thumb"
          ? record.thumbPath
          : record.originalPath;
  if (!path) return new Response("Not found", { status: 404 });

  const client = db();
  if (!client) return new Response("Not found", { status: 404 });

  const bucket = kind === "original" ? BUCKETS.captures : BUCKETS.crops;
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) return new Response("Not found", { status: 404 });

  return new Response(await data.arrayBuffer(), {
    headers: {
      "content-type": kind === "original" ? "image/jpeg" : "image/png",
      // Private and short: this is patient evidence, not a static asset. It may
      // sit in the viewer's own cache for the length of a review, and nowhere
      // shared.
      "cache-control": "private, max-age=300",
    },
  });
}

export function imageKinds(): readonly Kind[] {
  return KINDS;
}
