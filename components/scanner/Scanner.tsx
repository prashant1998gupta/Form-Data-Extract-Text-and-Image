"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { CheckCircle, Alert } from "@/components/icons";
import { useToast } from "@/components/Toast";
import { extractForm, validateFormFile, type ExtractedForm, type ScanStage } from "@/lib/client/extract-form";
import { scanStore, type Persistence } from "@/lib/client/scan-store";
import {
  emptyValues,
  fieldByKey,
  fieldsOf,
  normaliseValues,
  recordTitle,
  type FormDefinition,
  type FormValues,
} from "@/lib/forms/definitions";
import type { SavedScan } from "@/lib/scans/types";
import RecordForm, { type ReviewMarks } from "./RecordForm";
import ScanPanel, { type PickedImage } from "./ScanPanel";

type Props = {
  form: FormDefinition;
  persistence: Persistence;
  /** A saved scan to edit, from `?edit=`. */
  editId: string | null;
};

const EMPTY_REVIEW: ReviewMarks = { unreadable: new Set(), notInOptions: new Set(), photoNote: null, photoNeedsReview: false };

/**
 * The scan screen, in CardLink's shape: scan on top, the editable record
 * below, a save dock at the bottom. One scan fills the record; the person
 * checks it against the paper; Save writes it once.
 */
export default function Scanner({ form, persistence, editId }: Props) {
  const router = useRouter();
  const store = useMemo(() => scanStore(persistence), [persistence]);
  const [toast, notify] = useToast();

  const [image, setImage] = useState<PickedImage | null>(null);
  const [inputReset, setInputReset] = useState(0);
  const [scanError, setScanError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<ScanStage>("");
  const [result, setResult] = useState<ExtractedForm | null>(null);

  const [values, setValues] = useState<FormValues>(() => emptyValues(form));
  const [photo, setPhoto] = useState<string | null>(null);
  // Whether the photograph differs from what is stored, so an edit that never
  // touched it does not re-upload — or worse, replace — the saved one.
  const [photoTouched, setPhotoTouched] = useState(false);

  const [saved, setSaved] = useState<SavedScan | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(Boolean(editId));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // The latch lesson: `busy` re-renders the button, it does not guard — every
  // click in the same tick reads the pre-render value and passes.
  const scanLatch = useRef(false);
  const recordRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editId) return;
    let active = true;
    store
      .get(editId)
      .then((scan) => {
        if (!active) return;
        if (!scan || scan.form !== form.id) {
          setSaveError("That saved scan could not be found. Scan a new form instead.");
        } else {
          setSaved(scan);
          setValues(normaliseValues(form, scan.values));
          setPhoto(scan.photoUrl);
        }
      })
      .catch(() => active && setSaveError("The saved scan could not be loaded."))
      .finally(() => active && setLoadingEdit(false));
    return () => {
      active = false;
    };
  }, [editId, form, store]);

  function selectFile(file: File) {
    setScanError("");
    try {
      validateFormFile(file);
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "That file cannot be used.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setImage({ file, dataUrl: String(reader.result), name: file.name });
    reader.readAsDataURL(file);
  }

  function removeImage() {
    setImage(null);
    setInputReset((n) => n + 1);
    setScanError("");
  }

  async function scan() {
    if (scanLatch.current || !image) return;
    scanLatch.current = true;
    setBusy(true);
    setScanError("");
    setSaveError("");
    try {
      const extracted = await extractForm(image.file, form.id, setStage);
      setResult(extracted);
      setValues(normaliseValues(form, extracted.values));
      setPhoto(extracted.photo.found ? extracted.photo.dataUrl : null);
      setPhotoTouched(true);
      // A scan is always a NEW record. Filling a saved record from a different
      // piece of paper and then pressing Update would overwrite someone else.
      setSaved(null);
      requestAnimationFrame(() => recordRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "The form could not be scanned. Try a sharper photo.");
    } finally {
      scanLatch.current = false;
      setBusy(false);
      setStage("");
    }
  }

  function changeValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function changePhoto(next: string | null) {
    setPhoto(next);
    setPhotoTouched(true);
  }

  const title = recordTitle(form, values);
  const titleLabel = fieldByKey(form, form.titleKey)?.label ?? "name";

  async function save() {
    if (saving || loadingEdit) return;
    if (!title) {
      setSaveError(`Enter the ${titleLabel.toLowerCase()} before saving.`);
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const scan = saved
        ? await store.update(saved.id, { values, photo: photoTouched ? photo : undefined })
        : await store.create({ form: form.id, values, photo });
      setSaved(scan);
      setPhoto(scan.photoUrl);
      setPhotoTouched(false);
      notify(saved ? `Updated ${scan.reference}` : `Saved as ${scan.reference}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The scan could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function scanAnother() {
    setImage(null);
    setInputReset((n) => n + 1);
    setResult(null);
    setValues(emptyValues(form));
    setPhoto(null);
    setPhotoTouched(false);
    setSaved(null);
    setScanError("");
    setSaveError("");
    if (editId) router.replace(`/scan/${form.id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const review: ReviewMarks = result
    ? {
        unreadable: new Set(result.unreadable),
        notInOptions: new Set(result.notInOptions),
        photoNote: result.photo.detail
          ? result.photo.found
            ? `Cut from the form — ${result.photo.detail}.`
            : `No photograph was cut from the form: ${result.photo.detail}.`
          : null,
        photoNeedsReview: !result.photo.found || Boolean(result.photo.needsReview),
      }
    : EMPTY_REVIEW;

  const total = fieldsOf(form).length;
  const status = saved
    ? `${saved.reference} · saved ${persistence === "database" ? "to the database" : "in this browser"}`
    : result
      ? "Not saved yet — check the details, then save."
      : "Nothing saved yet.";

  return (
    <>
      <ScanPanel
        image={image}
        inputReset={inputReset}
        busy={busy}
        stage={stage}
        error={scanError}
        onSelect={selectFile}
        onRemove={removeImage}
        onScan={scan}
      />

      {result && (
        <div className={`scan-result ${result.readable ? "" : "is-warning"}`} role="status">
          {result.readable ? <CheckCircle /> : <Alert />}
          <div className="scan-result-copy">
            <strong>{result.readable ? "Form details ready for review" : "This could not be read as the form"}</strong>
            <p>
              {result.readable
                ? `${result.filled} of ${total} fields were filled from the form.` +
                  (result.unreadable.length
                    ? ` ${result.unreadable.length} could not be read and ${result.unreadable.length === 1 ? "is" : "are"} highlighted.`
                    : "") +
                  (result.photo.found ? " The photograph was cut from the form." : " No photograph was found.")
                : `It does not look like a readable copy of the ${form.name}. Try a sharper photo with the whole page in frame, or fill the details in by hand.`}
            </p>
          </div>
          <button type="button" className="button ghost small" onClick={scanAnother}>
            Scan another
          </button>
        </div>
      )}

      <div className="record-section" ref={recordRef} id="record">
        <div className="column-title">
          <div>
            <span className="eyebrow">{result ? "Step 2 · Check and save" : "Or fill in by hand"}</span>
            <h2>{saved ? `Editing ${saved.reference}` : "Record details"}</h2>
          </div>
          <small>{result?.unreadable.length ? "Highlighted fields need checking" : `Only the ${titleLabel.toLowerCase()} is required`}</small>
        </div>

        {loadingEdit ? (
          <p className="section-note">Loading the saved scan…</p>
        ) : (
          <RecordForm form={form} values={values} onChange={changeValue} photo={photo} onPhotoChange={changePhoto} review={review} />
        )}
      </div>

      <div className="save-dock">
        <div className="save-status">{status}</div>
        <div className="save-actions">
          {saved && (
            <>
              <button type="button" className="button ghost" onClick={scanAnother}>
                Scan another
              </button>
              <Link className="button ghost" href="/saved">
                View saved
              </Link>
            </>
          )}
          <button type="button" className="button primary" onClick={save} disabled={saving || loadingEdit} aria-busy={saving}>
            {saving ? "Saving…" : saved ? "Update scan" : persistence === "database" ? "Save scan" : "Save in this browser"}
          </button>
        </div>
        {saveError && (
          <p className="field-error" role="alert">
            {saveError}
          </p>
        )}
      </div>

      {toast}
    </>
  );
}
