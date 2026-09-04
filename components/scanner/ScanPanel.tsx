"use client";

import Image from "next/image";

import { Camera, ImageSquare, Spark, X } from "@/components/icons";
import type { ScanStage } from "@/lib/client/extract-form";

export interface PickedImage {
  readonly file: File;
  readonly dataUrl: string;
  readonly name: string;
}

const STAGE_LABELS: Record<ScanStage, string> = {
  preparing: "Preparing the photo…",
  reading: "Reading the form…",
  finishing: "Filling in the details…",
  "": "",
};

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif";

type Props = {
  image: PickedImage | null;
  /** Bumped to remount the file inputs — the only reliable way to clear one. */
  inputReset: number;
  busy: boolean;
  stage: ScanStage;
  error: string;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onScan: () => void;
};

/**
 * Step one: the photograph of the paper. Camera-first on the tile, with the
 * gallery as the second door — the same two doors CardLink's card tiles have.
 */
export default function ScanPanel({ image, inputReset, busy, stage, error, onSelect, onRemove, onScan }: Props) {
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onSelect(file);
  };

  return (
    <section className="scan-panel" aria-labelledby="scan-title">
      <div className="scan-copy">
        <p className="eyebrow">Step 1 · Scan</p>
        <h2 id="scan-title">Photograph the filled-in form</h2>
        <p>
          Take a photo of the whole page in good light, or choose one from your gallery. The answers and the
          photograph are read into the form below for you to check.
        </p>
      </div>

      <div className={`scan-tray ${busy ? "is-scanning" : ""}`}>
        <div className="upload-grid">
          <div className={`upload-tile ${image ? "has-image" : ""}`}>
            {image ? (
              <Image src={image.dataUrl} alt="The photographed form" width={520} height={700} unoptimized />
            ) : (
              <span className="upload-icon">
                <Camera size={30} />
              </span>
            )}
            <div className="upload-overlay">
              <strong>{image ? image.name : "Take a photo"}</strong>
              <span>{image ? "Tap to retake" : "Whole page in frame"}</span>
            </div>
            <label className="upload-trigger">
              <span className="visually-hidden">Take a photo of the form</span>
              <input
                key={`camera-${inputReset}-${image ? "picked" : "empty"}`}
                className="visually-hidden"
                type="file"
                accept={ACCEPT}
                capture="environment"
                onChange={pick}
                disabled={busy}
              />
            </label>
            {image && (
              <button type="button" className="upload-remove" onClick={onRemove} aria-label="Remove the photo" disabled={busy}>
                <X size={18} />
              </button>
            )}
          </div>

          <label className="upload-gallery">
            <ImageSquare size={26} />
            <span>Choose from Photos</span>
            <small>JPG, PNG or WebP</small>
            <input
              key={`gallery-${inputReset}`}
              className="visually-hidden"
              type="file"
              accept={ACCEPT}
              onChange={pick}
              disabled={busy}
            />
          </label>
        </div>

        <div className="scan-footer">
          <div className="scan-privacy">
            <span>
              <Spark size={16} /> AI form reading
            </span>
            <small>Sent once for reading. Kept only if you save the scan.</small>
          </div>
          <button type="button" className="button primary scan-button" onClick={onScan} disabled={busy || !image} aria-busy={busy}>
            {busy ? STAGE_LABELS[stage] || "Scanning…" : "Read Form & Fill"}
          </button>
        </div>

        {busy && (
          <div className="scan-progress" role="status" aria-live="polite" aria-label={STAGE_LABELS[stage] || "Scanning"}>
            <span />
          </div>
        )}
        {error && (
          <p className="scan-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
