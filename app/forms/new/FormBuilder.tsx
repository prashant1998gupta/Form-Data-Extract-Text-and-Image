"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { prepareUpload, UploadPrepareError } from "@/lib/client/prepare-upload";
import TemplateEditor, { type DrawnTemplate } from "../../TemplateEditor";

/**
 * Building a form: photograph the paper, draw its fields, publish the link.
 *
 * WHY IT STARTS WITH A PHOTOGRAPH rather than a blank canvas. Every competing
 * design of this screen is a form builder — drag a "Text field" widget into a
 * column, type a label, repeat — and every one of them produces a digital form
 * that has no idea where anything is on the PAPER. This product's entire
 * advantage is that it knows: a box drawn over the real page is geometry the
 * extractor can use. So the builder is the paper, with boxes drawn on it, and
 * the "digital form" falls out of that rather than the other way round.
 *
 * The page is RECTIFIED first, by the same pipeline a scan goes through, so
 * the boxes are drawn in the coordinate space every later scan is measured in.
 * Drawing on the raw photo would bake this one capture's perspective into the
 * template.
 */
export default function FormBuilder() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<{ dataUrl: string; pageMM: { widthMM: number; heightMM: number } } | null>(null);
  const [saved, setSaved] = useState<{ name: string; slug: string; status: string } | null>(null);
  const inFlight = useRef(false);

  const onFile = useCallback(async (file: File) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("Squaring the page");
    setError(null);

    try {
      const prepared = await prepareUpload(file);
      const body = new FormData();
      body.append("image", prepared.file);

      // The seeded template is sent only so the pipeline has something to
      // register against; its findings are ignored here. What this request is
      // actually for is the RECTIFIED PAGE — the surface the boxes get drawn on.
      const response = await fetch("/api/extract", { method: "POST", body });
      const payload = (await response.json().catch(() => null)) as
        | { rectified?: { dataUrl: string }; template?: { page: { widthMM: number; heightMM: number } }; error?: string }
        | null;

      if (!response.ok || !payload?.rectified) {
        setError(payload?.error ?? "That photo could not be prepared. Try again with the whole page in frame.");
        return;
      }
      setPage({
        dataUrl: payload.rectified.dataUrl,
        pageMM: payload.template?.page ?? { widthMM: 210, heightMM: 297 },
      });
    } catch (cause) {
      setError(
        cause instanceof UploadPrepareError ? cause.message : "That photo could not be prepared for upload.",
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, []);

  const publish = useCallback(
    async (template: DrawnTemplate) => {
      setBusy("Publishing");
      setError(null);
      try {
        const response = await fetch("/api/forms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: template.name, template, publish: true }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { form?: { name: string; slug: string; status: string }; error?: string }
          | null;

        if (!response.ok || !payload?.form) {
          setError(payload?.error ?? "That form could not be published.");
          return;
        }
        setSaved(payload.form);
        router.refresh();
      } catch {
        setError("The form did not reach the server. Check your connection and try again.");
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  if (saved) {
    const link = typeof window === "undefined" ? `/f/${saved.slug}` : `${window.location.origin}/f/${saved.slug}`;
    return (
      <div className="pane">
        <header>
          <h2>{saved.name} is published</h2>
        </header>
        <div className="pane-body">
          <p style={{ marginTop: 0 }}>
            Staff open this link to scan a filled-in copy. Every scan they verify and save becomes a
            record against this form.
          </p>
          <p className="published-link">
            <a href={`/f/${saved.slug}`}>{link}</a>
          </p>
          <div className="actions" style={{ justifyContent: "flex-start", marginTop: 16, flexWrap: "wrap" }}>
            <a className="button" href={`/f/${saved.slug}`}>
              Open it now
            </a>
            <a className="button secondary" href="/forms">
              All forms
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (busy) {
    return (
      <div className="pane">
        <div className="progress">
          <div className="spinner" aria-hidden="true" />
          <strong>{busy}</strong>
          <span>One moment.</span>
        </div>
      </div>
    );
  }

  if (page) {
    return (
      <TemplateEditor
        pageDataUrl={page.dataUrl}
        pageMM={page.pageMM}
        onCancel={() => setPage(null)}
        onSave={(template) => void publish(template)}
        saveLabel="Publish this form"
      />
    );
  }

  return (
    <>
      {error ? (
        <p className="notice error" role="alert" style={{ marginBottom: 18 }}>
          {error}
        </p>
      ) : null}

      <div className="dropzone">
        <h2>Photograph your blank form</h2>
        <p>
          Use an <strong>empty</strong> copy — nothing filled in, nothing pasted. You will draw a box
          around each thing people write in, and every future scan of this form is measured against
          those boxes.
        </p>
        <div className="actions">
          <label className="button">
            Take a photo
            <input
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onFile(file);
              }}
            />
          </label>
          <label className="button secondary">
            Choose a file
            <input
              className="visually-hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void onFile(file);
              }}
            />
          </label>
        </div>

        <div className="samples">
          <span>No form to hand?</span>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const response = await fetch("/samples/unfilled.jpg");
                const blob = await response.blob();
                await onFile(new File([blob], "unfilled.jpg", { type: "image/jpeg" }));
              })();
            }}
          >
            Use the sample blank form
          </button>
        </div>
      </div>
    </>
  );
}
