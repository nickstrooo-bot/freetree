import {
  FORM_HONEYPOT_FIELD,
  MAX_ANSWER_LENGTH,
  type FormDefinition,
  type FormField,
} from "@kytelink/schemas";

// ─── Forms renderer ──────────────────────────────────────────────────────────
// One small renderer turns a form JSON document into HTML (SurveyJS storage
// pattern: the form IS the JSON, this is the only place that knows how to
// draw it). Used by the public embed endpoint (GET /forms/embed/:token) so a
// seller can paste a working form into any site with no JavaScript, and as
// the no-JS fallback for the profile page. Every seller-controlled string is
// escaped — a label must never be able to break out of the markup.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderField(field: FormField): string {
  const id = escapeHtml(field.id);
  const label = escapeHtml(field.label);
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
  const required = field.required ? " required" : "";
  const maxLength = ` maxlength="${field.maxLength ?? MAX_ANSWER_LENGTH}"`;
  const labelHtml = `<label for="freetree-${id}">${label}${field.required ? ' <span aria-hidden="true">*</span>' : ""}</label>`;

  switch (field.type) {
    case "text":
      return `${labelHtml}<input type="text" id="freetree-${id}" name="${id}"${placeholder}${required}${maxLength}>`;
    case "email":
      return `${labelHtml}<input type="email" id="freetree-${id}" name="${id}"${placeholder}${required}${maxLength}>`;
    case "textarea":
      return `${labelHtml}<textarea id="freetree-${id}" name="${id}" rows="4"${placeholder}${required}${maxLength}></textarea>`;
    case "choice":
      return (
        `${labelHtml}<select id="freetree-${id}" name="${id}"${required}>` +
        `<option value="">—</option>` +
        (field.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("") +
        `</select>`
      );
  }
}

export type RenderFormOptions = {
  /** Public submit endpoint path, e.g. `/forms/submit/<token>`. */
  endpointPath: string;
  title: string;
  description?: string | null;
  buttonText: string;
};

/**
 * Render a complete standalone `<form>` for the given definition. The
 * honeypot input is a normal-looking text field hidden from humans (CSS +
 * aria-hidden + tabindex -1); bots fill it, humans never do. The form posts
 * to the endpoint directly, so it works with JavaScript disabled.
 */
export function renderFormHtml(definition: FormDefinition, options: RenderFormOptions): string {
  const fieldsHtml = definition.fields.map((f) => `<div>${renderField(f)}</div>`).join("\n");
  const descriptionHtml = options.description
    ? `<p>${escapeHtml(options.description)}</p>`
    : "";
  return [
    `<form action="${escapeHtml(options.endpointPath)}" method="post">`,
    `<h2>${escapeHtml(options.title)}</h2>`,
    descriptionHtml,
    fieldsHtml,
    // Honeypot — visually hidden, not `type="hidden"` (bots skip those).
    `<div style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;" aria-hidden="true"><label for="freetree-${FORM_HONEYPOT_FIELD}">Website</label><input type="text" id="freetree-${FORM_HONEYPOT_FIELD}" name="${FORM_HONEYPOT_FIELD}" tabindex="-1" autocomplete="off"></div>`,
    `<button type="submit">${escapeHtml(options.buttonText)}</button>`,
    `</form>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
