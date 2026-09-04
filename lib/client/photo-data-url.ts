/**
 * A photograph the person chose themselves, made storable.
 *
 * The scan's own crop arrives as a print-resolution PNG; a photo picked from
 * the gallery is a multi-megabyte camera frame. Both end up in the same
 * `photo` slot, so this brings the second down to a print-sized JPEG the
 * stores accept without complaint.
 */

const MAX_EDGE = 900;
const QUALITY = 0.9;

export async function fileToPhotoDataUrl(file: File): Promise<string> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot read the photo. Try Chrome, Safari or Firefox.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("That file is not an image the browser can read. Choose a JPG, PNG or WebP photo.");
  }
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser could not process the photo.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", QUALITY);
  } finally {
    bitmap.close?.();
  }
}
