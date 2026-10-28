// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitForm, WaitFormField } from "@zerodot/engine";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const optionsOf = (field: WaitFormField) => field.fieldOptions?.values.map((v) => v.option) ?? [];

function control(field: WaitFormField, name: string): string {
  const required = field.requiredField ? " required" : "";
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : "";
  const type = field.fieldType ?? "text";
  if (type === "textarea")
    return `<textarea name="${name}" rows="4"${required}${placeholder}></textarea>`;
  if (type === "dropdown") {
    const options = optionsOf(field).map((o) => `<option>${escapeHtml(o)}</option>`);
    return `<select name="${name}"${required}><option value="">Choose</option>${options.join("")}</select>`;
  }
  if (type === "checkbox" || type === "radio") {
    return optionsOf(field)
      .map(
        (o) =>
          `<label class="choice"><input type="${type}" name="${name}" value="${escapeHtml(o)}"> ${escapeHtml(o)}</label>`,
      )
      .join("");
  }
  return `<input type="${type}" name="${name}"${required}${placeholder}>`;
}

const PAGE = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>zerodot</title><style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111}label{display:block;margin:1rem 0 .25rem;font-weight:500}.choice{font-weight:400;margin:.25rem 0}input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:6px;font:inherit;box-sizing:border-box}button{margin-top:1.5rem;padding:.5rem 1rem;border:0;border-radius:6px;background:#111;color:#fff;font:inherit}p{color:#555}</style></head><body>${body}</body></html>`;

export function renderWaitForm(form: WaitForm): string {
  const fields = form.fields
    .map(
      (field, index) =>
        `<label for="f${index}">${escapeHtml(field.fieldLabel)}</label>${control(field, `f${index}`)}`,
    )
    .join("");
  return PAGE(
    `<h1>${escapeHtml(form.title ?? "Respond")}</h1>${
      form.description ? `<p>${escapeHtml(form.description)}</p>` : ""
    }<form method="post">${fields}<button type="submit">${escapeHtml(form.buttonLabel ?? "Submit")}</button></form>`,
  );
}

export const messagePage = (text: string) => PAGE(`<p>${escapeHtml(text)}</p>`);

/** The answers of a form post, with the field labels as keys. A missing required field gives an error. */
export function parseWaitForm(
  form: WaitForm,
  data: FormData,
): { ok: true; answers: Record<string, unknown> } | { ok: false; error: string } {
  const answers: Record<string, unknown> = {};
  for (const [index, field] of form.fields.entries()) {
    const name = `f${index}`;
    const key = field.key ?? field.fieldLabel;
    const raw = field.fieldType === "checkbox" ? data.getAll(name).map(String) : data.get(name);
    const empty = Array.isArray(raw) ? raw.length === 0 : raw === null || raw === "";
    if (empty) {
      if (field.requiredField) return { ok: false, error: `"${field.fieldLabel}" is required` };
      continue;
    }
    if (Array.isArray(raw)) {
      answers[key] = raw;
    } else if (field.fieldType === "number") {
      const value = Number(raw);
      if (Number.isNaN(value)) return { ok: false, error: `"${field.fieldLabel}" is not a number` };
      answers[key] = value;
    } else {
      const text = String(raw);
      const allowed = optionsOf(field);
      if (
        (field.fieldType === "dropdown" || field.fieldType === "radio") &&
        !allowed.includes(text)
      ) {
        return { ok: false, error: `"${field.fieldLabel}" has a value that is not allowed` };
      }
      answers[key] = text;
    }
  }
  return { ok: true, answers };
}
