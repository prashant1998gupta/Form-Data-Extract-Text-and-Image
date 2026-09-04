import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { scanPhoto } from "@/lib/db/scans";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A scan's photograph, served BY THIS APPLICATION rather than by a storage
 * link. A signed storage URL in the page is a bearer token for a person's
 * face that keeps working after the tab closes and can be pasted anywhere;
 * streaming through here means the token never leaves the server, and there
 * is exactly one place to add an authorization check when accounts land.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!isDatabaseConfigured() || !UUID.test(id)) return new Response("Not found", { status: 404 });

  let photo;
  try {
    photo = await scanPhoto(id);
  } catch (error) {
    console.error("scan photo failed", error);
    return new Response("Not found", { status: 404 });
  }
  if (!photo) return new Response("Not found", { status: 404 });

  return new Response(photo.bytes, {
    headers: {
      "content-type": photo.contentType,
      // Private and short: a person's photograph, not a static asset.
      "cache-control": "private, max-age=300",
    },
  });
}
