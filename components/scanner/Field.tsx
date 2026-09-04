"use client";

import { checklistItems, joinChecklist, type FieldDefinition } from "@/lib/forms/definitions";

export type FieldFlag = "unreadable" | "notInOptions" | null;

type Props = {
  field: FieldDefinition;
  value: string;
  onChange: (key: string, value: string) => void;
  flag: FieldFlag;
  required?: boolean;
};

const FLAG_TEXT: Record<Exclude<FieldFlag, null>, string> = {
  unreadable: "Could not be read — check the paper",
  notInOptions: "Not one of the printed options — check the paper",
};

/**
 * Everything a phone number can legitimately contain. Filtering as the person
 * types rather than scolding on save, because the stray characters usually
 * arrive from the reader, not the keyboard.
 */
const NOT_PHONE = /[^0-9+()\-.\s]/g;

/** One field of the editable form, drawn by its kind. */
export default function Field({ field, value, onChange, flag, required = false }: Props) {
  const id = `field-${field.key}`;
  const className = ["field", field.wide ? "field-wide" : "", flag ? "needs-review" : ""].filter(Boolean).join(" ");
  const note = flag ? <small className="field-note">{FLAG_TEXT[flag]}</small> : null;
  const label = (
    <span className="field-label">
      {field.label}
      {required && <b className="field-required" aria-hidden="true">*</b>}
    </span>
  );

  if (field.kind === "checklist") {
    const options = field.options ?? [];
    const ticked = new Set(checklistItems(value).map((item) => item.toLowerCase()));
    // Anything ticked that is not a printed option still shows, so a value the
    // reader wrote loosely is visible rather than silently dropped.
    const extras = checklistItems(value).filter((item) => !options.some((option) => option.toLowerCase() === item.toLowerCase()));
    const toggle = (option: string, on: boolean) => {
      const items = checklistItems(value).filter((item) => item.toLowerCase() !== option.toLowerCase());
      onChange(field.key, joinChecklist(on ? [...items, option] : items));
    };
    return (
      <fieldset className={`${className} checklist`}>
        <legend className="field-label">{field.label}</legend>
        <div className="checklist-options">
          {[...options, ...extras].map((option) => (
            <label key={option} className="check">
              <input type="checkbox" checked={ticked.has(option.toLowerCase())} onChange={(event) => toggle(option, event.target.checked)} />
              <span>{option}</span>
            </label>
          ))}
        </div>
        {note}
      </fieldset>
    );
  }

  if (field.kind === "choice" || field.kind === "yesno") {
    const options = field.kind === "yesno" ? ["Yes", "No"] : (field.options ?? []);
    const asWritten = value && !options.includes(value) ? value : null;
    return (
      <label className={className} htmlFor={id}>
        {label}
        <select id={id} name={field.key} value={value} onChange={(event) => onChange(field.key, event.target.value)}>
          <option value="">—</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
          {asWritten && <option value={asWritten}>{asWritten} (as written)</option>}
        </select>
        {note}
      </label>
    );
  }

  if (field.kind === "multiline") {
    return (
      <label className={className} htmlFor={id}>
        {label}
        <textarea id={id} name={field.key} value={value} rows={3} placeholder={field.placeholder} onChange={(event) => onChange(field.key, event.target.value)} />
        {note}
      </label>
    );
  }

  const phone = field.kind === "phone";
  return (
    <label className={className} htmlFor={id}>
      {label}
      <input
        id={id}
        name={field.key}
        value={value}
        type={field.kind === "email" ? "email" : phone ? "tel" : "text"}
        inputMode={phone ? "tel" : field.kind === "number" ? "numeric" : undefined}
        autoCapitalize={field.kind === "name" ? "words" : undefined}
        placeholder={field.placeholder}
        required={required}
        aria-required={required || undefined}
        onChange={(event) => onChange(field.key, phone ? event.target.value.replace(NOT_PHONE, "") : event.target.value)}
      />
      {note}
    </label>
  );
}
