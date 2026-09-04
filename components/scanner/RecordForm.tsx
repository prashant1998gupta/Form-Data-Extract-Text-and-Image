"use client";

import Image from "next/image";
import { useState } from "react";

import { Alert, User } from "@/components/icons";
import { fileToPhotoDataUrl } from "@/lib/client/photo-data-url";
import { recordTitle, type FormDefinition, type FormValues } from "@/lib/forms/definitions";
import Field, { type FieldFlag } from "./Field";

export interface ReviewMarks {
  readonly unreadable: ReadonlySet<string>;
  readonly notInOptions: ReadonlySet<string>;
  /** What the scan said about the photograph, shown under it. */
  readonly photoNote: string | null;
  readonly photoNeedsReview: boolean;
}

type Props = {
  form: FormDefinition;
  values: FormValues;
  onChange: (key: string, value: string) => void;
  photo: string | null;
  onPhotoChange: (dataUrl: string | null) => void;
  review: ReviewMarks;
};

/** Up to two initials for the photo placeholder. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

/**
 * The editable record: the photograph on top, then every section of the form
 * with the values the reader filled in, each open for checking against the
 * paper. Fields the reader could not read are highlighted, not hidden.
 */
export default function RecordForm({ form, values, onChange, photo, onPhotoChange, review }: Props) {
  const [photoError, setPhotoError] = useState("");
  const title = recordTitle(form, values);

  async function pickPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoError("");
    try {
      onPhotoChange(await fileToPhotoDataUrl(file));
    } catch (error) {
      setPhotoError(error instanceof Error ? error.message : "That photo could not be used.");
    }
  }

  return (
    <div className="record-form">
      <section className="photo-card" aria-labelledby="photo-title">
        <div className={`photo-frame ${photo ? "has-photo" : ""}`}>
          {photo ? (
            <Image src={photo} alt={`${form.photo.label} from the form`} width={140} height={180} unoptimized />
          ) : (
            <span className="photo-placeholder" aria-hidden="true">
              {initialsOf(title) || <User size={34} />}
            </span>
          )}
        </div>
        <div className="photo-copy">
          <h3 id="photo-title">{form.photo.label}</h3>
          {review.photoNote && (
            <p className={review.photoNeedsReview ? "photo-note review" : "photo-note"}>
              {review.photoNeedsReview && <Alert size={16} />}
              {review.photoNote}
            </p>
          )}
          {!review.photoNote && <p className="photo-note">Cut from the form when it is scanned. You can also choose one.</p>}
          <div className="photo-actions">
            <label className="button small">
              {photo ? "Replace photo" : "Choose photo"}
              <input className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={pickPhoto} />
            </label>
            {photo && (
              <button type="button" className="button text danger" onClick={() => onPhotoChange(null)}>
                Remove
              </button>
            )}
          </div>
          {photoError && (
            <p className="field-error" role="alert">
              {photoError}
            </p>
          )}
        </div>
      </section>

      {form.sections.map((section, index) => (
        <details key={section.id} className="form-section" open>
          <summary>
            <span className="section-number">{String(index + 1).padStart(2, "0")}</span>
            <span className="section-heading">
              <strong>{section.title}</strong>
              <small>{section.fields.length} field{section.fields.length === 1 ? "" : "s"}</small>
            </span>
          </summary>
          <div className="section-content">
            <div className="field-grid">
              {section.fields.map((field) => {
                const flag: FieldFlag = review.unreadable.has(field.key)
                  ? "unreadable"
                  : review.notInOptions.has(field.key)
                    ? "notInOptions"
                    : null;
                return (
                  <Field
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? ""}
                    onChange={onChange}
                    flag={flag}
                    required={field.key === form.titleKey}
                  />
                );
              })}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
