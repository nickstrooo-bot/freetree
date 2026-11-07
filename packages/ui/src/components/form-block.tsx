import { useState, type CSSProperties, type FormEvent } from "react";
import type { FormField } from "@kytelink/schemas";
import { FORM_HONEYPOT_FIELD } from "@kytelink/schemas";
import type { ThemeExtras } from "../theme-extras";

// ─── Form block (public profile) ─────────────────────────────────────────────
// A seller's contact form: title + fields rendered from the form JSON
// document, one POST to the form's unique endpoint. Mirrors
// EmailSignupBlock's card styling so the profile stays consistent. The
// honeypot input is a normal-looking text field hidden from humans; bots
// fill it, humans never do — the API stores those as spam without telling
// the sender anything.

export interface PublicFormBlock {
  title: string;
  description: string | null;
  buttonText: string;
  successText: string;
  fields: FormField[];
  endpointPath: string;
}

interface FormBlockProps {
  block: PublicFormBlock;
  extras: ThemeExtras;
  linkColor: string;
  textShadow: string | undefined;
  /** Called with the visitor's answers. Parent handles the API call. */
  onSubmit: (answers: Record<string, string>) => Promise<{ successText: string }>;
}

type Status = "idle" | "submitting" | "done" | "error";

export function FormBlock({ block, extras, linkColor, textShadow, onSubmit }: FormBlockProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errorMsg, setErrorMsg] = useState("");
  const [doneText, setDoneText] = useState(block.successText);

  const cardStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "100%",
    padding: "18px",
    borderRadius: extras.linkRadius,
    background: extras.link.background,
    border: extras.link.border,
    boxShadow: extras.link.boxShadow,
    backdropFilter: extras.link.backdropFilter,
    WebkitBackdropFilter: extras.link.backdropFilter,
    color: linkColor,
    textShadow,
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "1px solid rgba(128,128,128,0.35)",
    background: "rgba(255,255,255,0.85)",
    color: "#1a1a1a",
    fontSize: "15px",
    outline: "none",
    textShadow: "none",
  };

  const buttonStyle: CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "10px",
    border: "none",
    background: "#1B4332",
    color: "#FDF8F0",
    fontSize: "15px",
    fontWeight: 600,
    cursor: status === "submitting" ? "wait" : "pointer",
    opacity: status === "submitting" ? 0.7 : 1,
  };

  function setValue(id: string, value: string) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    for (const field of block.fields) {
      const value = (values[field.id] ?? "").trim();
      if (field.required && value === "") errors[field.id] = "This field is required.";
      if (field.type === "email" && value !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors[field.id] = "That doesn't look like an email address.";
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setStatus("error");
      return;
    }
    setStatus("submitting");
    setFieldErrors({});
    setErrorMsg("");
    try {
      // The honeypot rides along like any other field; the API decides what
      // it means. A filled honeypot still gets the success message.
      const result = await onSubmit({ ...values, [FORM_HONEYPOT_FIELD]: honeypot });
      setDoneText(result.successText);
      setStatus("done");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // The API returns field errors as JSON in the message ("field:id:…").
      // Anything else is a generic failure.
      if (message.startsWith("field:")) {
        const parsed: Record<string, string> = {};
        for (const part of message.slice("field:".length).split(";")) {
          const [id, ...rest] = part.split(":");
          if (id) parsed[id] = rest.join(":") || "Check this field.";
        }
        setFieldErrors(parsed);
      } else {
        setErrorMsg("Something went wrong. Please try again.");
      }
      setStatus("error");
    }
  }

  function renderField(field: FormField) {
    const value = values[field.id] ?? "";
    const disabled = status === "submitting";
    const label = (
      <label htmlFor={`freetree-form-${field.id}`} style={{ fontSize: "13px", fontWeight: 600 }}>
        {field.label}
        {field.required ? " *" : ""}
      </label>
    );
    const error = fieldErrors[field.id] ? (
      <div style={{ fontSize: "13px", color: "#b91c1c", textShadow: "none" }}>{fieldErrors[field.id]}</div>
    ) : null;
    switch (field.type) {
      case "textarea":
        return (
          <div key={field.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {label}
            <textarea
              id={`freetree-form-${field.id}`}
              value={value}
              onChange={(e) => setValue(field.id, e.target.value)}
              placeholder={field.placeholder}
              rows={4}
              disabled={disabled}
              style={{ ...inputStyle, resize: "vertical" }}
            />
            {error}
          </div>
        );
      case "choice":
        return (
          <div key={field.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {label}
            <select
              id={`freetree-form-${field.id}`}
              value={value}
              onChange={(e) => setValue(field.id, e.target.value)}
              disabled={disabled}
              style={inputStyle}
            >
              <option value="">—</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {error}
          </div>
        );
      default:
        return (
          <div key={field.id} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {label}
            <input
              id={`freetree-form-${field.id}`}
              type={field.type === "email" ? "email" : "text"}
              value={value}
              onChange={(e) => setValue(field.id, e.target.value)}
              placeholder={field.placeholder}
              autoComplete={field.type === "email" ? "email" : undefined}
              disabled={disabled}
              style={inputStyle}
            />
            {error}
          </div>
        );
    }
  }

  return (
    <div data-freetree-form-block="" style={cardStyle}>
      <div style={{ fontSize: "16px", fontWeight: 700 }}>{block.title}</div>
      {block.description ? (
        <div style={{ fontSize: "14px", opacity: 0.85, lineHeight: 1.45 }}>{block.description}</div>
      ) : null}

      {status === "done" ? (
        <div style={{ fontSize: "14px", fontWeight: 600 }}>✅ {doneText}</div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {block.fields.map(renderField)}
          {/* Honeypot — visually hidden, not type="hidden" (bots skip those). */}
          <div
            style={{ position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", overflow: "hidden" }}
            aria-hidden="true"
          >
            <label htmlFor="freetree-form-website">Website</label>
            <input
              id="freetree-form-website"
              type="text"
              name={FORM_HONEYPOT_FIELD}
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
            />
          </div>
          {status === "error" && errorMsg ? (
            <div style={{ fontSize: "13px", color: "#b91c1c", textShadow: "none" }}>{errorMsg}</div>
          ) : null}
          <button type="submit" disabled={status === "submitting"} style={buttonStyle}>
            {status === "submitting" ? "Sending…" : block.buttonText}
          </button>
        </form>
      )}
    </div>
  );
}
