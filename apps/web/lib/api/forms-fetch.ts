import type { PublicFormBlock } from "@kytelink/ui";

const EMPTY: { form: PublicFormBlock | null } = { form: null };

/**
 * Server-side fetch of a profile's form block. Best-effort: any failure
 * returns null so a forms outage never breaks the page.
 */
export async function fetchPublicForm(
  username: string,
): Promise<{ form: PublicFormBlock | null }> {
  const base = process.env.API_BASE_URL ?? "http://localhost:3003";
  try {
    const response = await fetch(
      `${base}/forms/block/${encodeURIComponent(username.toLowerCase())}`,
    );
    if (!response.ok) return EMPTY;
    const data = (await response.json()) as { form?: PublicFormBlock | null };
    return { form: data.form ?? null };
  } catch {
    return EMPTY;
  }
}

/** Client-side: submit a visitor's answers to a form's unique endpoint. */
export async function submitForm(
  endpointPath: string,
  answers: Record<string, string>,
): Promise<{ successText: string }> {
  const base =
    process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:3003");
  const response = await fetch(`${base}${endpointPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answers),
  });
  const data = (await response.json()) as {
    ok?: boolean;
    successText?: string;
    error?: string;
    errors?: Record<string, string>;
  };
  if (!response.ok || !data.ok) {
    if (data.errors) {
      // Encode per-field errors so the block can show them inline.
      throw new Error(
        `field:${Object.entries(data.errors)
          .map(([id, message]) => `${id}:${message}`)
          .join(";")}`,
      );
    }
    throw new Error(data.error ?? "SUBMIT_FAILED");
  }
  return { successText: data.successText ?? "Thanks! I'll get back to you." };
}
