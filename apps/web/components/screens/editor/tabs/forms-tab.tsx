import { useCallback, useEffect, useState } from "react";
import { useEditor } from "../../../../lib/editor/editor-context";
import { useApp } from "../../../../lib/app-context";
import type { FormBlock, FormSubmission, FormSubmissionStatus } from "../../../../lib/api/client-interface";
import { Plus, Trash2, Download, Mail, Copy, RefreshCw } from "lucide-react";

type StatusFilter = FormSubmissionStatus | "all";

const STATUS_LABELS: Record<FormSubmissionStatus, string> = {
  new: "New",
  contacted: "Contacted",
  converted: "Converted",
};

const STARTER_FIELDS: FormBlock["fields"] = [
  { id: "name", type: "text", label: "Name", required: true, placeholder: "Your name" },
  { id: "email", type: "email", label: "Email", required: true, placeholder: "you@example.com" },
  { id: "message", type: "textarea", label: "Message", required: true, placeholder: "Say hello…" },
];

export function FormsTab() {
  const { kyte, allows } = useEditor();
  const { api, toast } = useApp();
  const readOnly = !allows("edit_draft");

  const [form, setForm] = useState<FormBlock | null>(null);
  const [submissions, setSubmissions] = useState<FormSubmission[]>([]);
  const [counts, setCounts] = useState({ new: 0, contacted: 0, converted: 0, spam: 0, total: 0 });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [includeSpam, setIncludeSpam] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Form settings state
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("Contact me");
  const [description, setDescription] = useState("");
  const [buttonText, setButtonText] = useState("Send message");
  const [successText, setSuccessText] = useState("Thanks! I'll get back to you.");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [active, setActive] = useState(true);

  // Per-submission edit state (notes + follow-up date, saved on blur/Enter)
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [followUpDraft, setFollowUpDraft] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([
        api.forms.getForm({ kyteId: kyte.id }),
        api.forms
          .listSubmissions({ kyteId: kyte.id, status: statusFilter, includeSpam, search: search || undefined, limit: 50 })
          .catch(() => ({
            submissions: [],
            nextCursor: null,
            counts: { new: 0, contacted: 0, converted: 0, spam: 0, total: 0 },
          })),
      ]);
      setForm(f.form);
      setSubmissions(s.submissions);
      setCounts(s.counts);
      setNextCursor(s.nextCursor);
      if (f.form) {
        setTitle(f.form.title);
        setDescription(f.form.description ?? "");
        setButtonText(f.form.buttonText);
        setSuccessText(f.form.successText);
        setNotifyEmail(f.form.notifyEmail ?? "");
        setActive(f.form.active);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't load forms.", "error");
    } finally {
      setLoading(false);
    }
  }, [api, kyte.id, statusFilter, includeSpam, search, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const s = await api.forms.listSubmissions({
        kyteId: kyte.id,
        status: statusFilter,
        includeSpam,
        search: search || undefined,
        limit: 50,
        cursor: nextCursor,
      });
      setSubmissions((prev) => [...prev, ...s.submissions]);
      setCounts(s.counts);
      setNextCursor(s.nextCursor);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't load more.", "error");
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.forms.upsertForm({
        kyteId: kyte.id,
        title: title.trim() || "Contact me",
        description: description.trim() || null,
        buttonText: buttonText.trim() || "Send message",
        successText: successText.trim() || "Thanks! I'll get back to you.",
        fields: form?.fields ?? STARTER_FIELDS,
        notifyEmail: notifyEmail.trim() || null,
        active,
      });
      setForm(updated);
      setFormOpen(false);
      toast("Contact form saved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteForm() {
    if (!window.confirm("Remove the contact form? All submissions will be deleted too.")) return;
    try {
      await api.forms.deleteForm({ kyteId: kyte.id });
      setForm(null);
      setSubmissions([]);
      setCounts({ new: 0, contacted: 0, converted: 0, spam: 0, total: 0 });
      toast("Contact form removed.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
  }

  async function handleRegenerate() {
    if (!window.confirm("Rotate the endpoint URL? Anywhere you embedded the old URL will stop working.")) return;
    try {
      const { endpointPath } = await api.forms.regenerateEndpoint({ kyteId: kyte.id });
      setForm((prev) => (prev ? { ...prev, endpointPath, endpointToken: endpointPath.split("/").pop() ?? prev.endpointToken } : prev));
      toast("Endpoint rotated. Update any embeds with the new URL.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't rotate the endpoint.", "error");
    }
  }

  async function handleCopyEndpoint() {
    if (!form) return;
    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "";
    const url = `${apiBase}${form.endpointPath}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Endpoint URL copied.", "success");
    } catch {
      toast(url, "error");
    }
  }

  async function handleUpdateSubmission(
    submission: FormSubmission,
    patch: { status?: FormSubmissionStatus; spam?: boolean; notes?: string | null; followUpAt?: string | null },
  ) {
    try {
      const { submission: updated } = await api.forms.updateSubmission({
        kyteId: kyte.id,
        submissionId: submission.id,
        ...patch,
      });
      setSubmissions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    }
  }

  async function handleDeleteSubmission(id: string) {
    try {
      await api.forms.deleteSubmission({ kyteId: kyte.id, submissionId: id });
      setSubmissions((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
  }

  async function handleExport() {
    try {
      const { csv, filename } = await api.forms.exportCsv({ kyteId: kyte.id });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Submissions downloaded.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't export.", "error");
    }
  }

  if (loading) {
    return <p className="text-sm text-tertiary">Loading your forms…</p>;
  }

  const endpointUrl = form ? `${process.env.NEXT_PUBLIC_API_URL ?? ""}${form.endpointPath}` : "";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Forms</h2>
        <p className="mt-0.5 text-[13px] text-tertiary">
          A contact form on your page, with every reply in one inbox — free forever. Linktree and Formspree charge for this.
        </p>
      </div>

      {!form && !formOpen ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-cardline bg-card px-6 py-12 text-center">
          <Mail className="size-8 text-tertiary" aria-hidden="true" />
          <p className="max-w-sm text-[13px] text-secondary">
            Add a contact form to your page. Visitors fill it in, replies land here, and you get an email for each one.
            The form asks for a name, email, and message.
          </p>
          {!readOnly ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-1 inline-flex items-center gap-2 rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
            >
              <Plus className="size-4" /> Add contact form
            </button>
          ) : null}
        </div>
      ) : null}

      {(formOpen || form) && (
        <form onSubmit={handleSave} className="flex flex-col gap-4 rounded-card border border-cardline bg-card p-5">
          <h3 className="text-sm font-semibold text-ink">
            {form ? "Form settings" : "New contact form"}
          </h3>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              disabled={readOnly}
              className="rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Description <span className="text-tertiary">(optional)</span></span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              disabled={readOnly}
              className="rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
            />
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Button text</span>
              <input
                value={buttonText}
                onChange={(e) => setButtonText(e.target.value)}
                maxLength={40}
                disabled={readOnly}
                className="w-48 rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Notify email <span className="text-tertiary">(blank = org owner)</span></span>
              <input
                type="email"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={readOnly}
                className="rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
              />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Success message</span>
            <input
              value={successText}
              onChange={(e) => setSuccessText(e.target.value)}
              maxLength={500}
              disabled={readOnly}
              className="rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              disabled={readOnly}
              className="size-4"
            />
            Show on my page
          </label>
          <div className="rounded-lg border border-cardline bg-background px-3 py-2">
            <p className="text-[13px] font-medium text-ink">Fields</p>
            <p className="text-[12px] text-tertiary">
              {(form?.fields ?? STARTER_FIELDS).map((f) => `${f.label}${f.required ? " *" : ""}`).join(" · ")}
            </p>
            <p className="mt-1 text-[11px] text-tertiary">
              Fixed set for now (name, email, message). A field builder with more field types is coming later.
            </p>
          </div>
          {form && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink">Endpoint URL — post to this from any site</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-cardline bg-background px-3 py-2 text-[12px] text-ink">
                  {endpointUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyEndpoint}
                  aria-label="Copy endpoint URL"
                  className="rounded-lg border border-cardline p-2 text-ink"
                >
                  <Copy className="size-4" />
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    aria-label="Rotate endpoint URL"
                    title="Rotate endpoint URL"
                    className="rounded-lg border border-cardline p-2 text-ink"
                  >
                    <RefreshCw className="size-4" />
                  </button>
                )}
              </div>
              <p className="text-[11px] text-tertiary">
                A no-JavaScript embed is available at {endpointUrl.replace("/submit/", "/embed/")}.
              </p>
            </div>
          )}
          {!readOnly && (
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-pill bg-accent px-5 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
              >
                {saving ? "Saving…" : form ? "Save changes" : "Add to my page"}
              </button>
              {formOpen && !form && (
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-pill border border-cardline px-5 py-2 text-sm text-ink"
                >
                  Cancel
                </button>
              )}
              {form && (
                <button
                  type="button"
                  onClick={handleDeleteForm}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-pill border border-red-200 px-4 py-2 text-sm text-red-700"
                >
                  <Trash2 className="size-4" /> Remove
                </button>
              )}
            </div>
          )}
        </form>
      )}

      {form && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">
              Inbox ({counts.total} total · {counts.new} new · {counts.contacted} contacted · {counts.converted} converted
              {counts.spam > 0 ? ` · ${counts.spam} spam` : ""})
            </h3>
            <div className="flex flex-wrap gap-2">
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setSearch(searchInput.trim());
                }}
                onBlur={() => setSearch(searchInput.trim())}
                placeholder="Search replies…"
                aria-label="Search submissions"
                className="rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink"
              />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink"
                aria-label="Filter by status"
              >
                <option value="all">All statuses</option>
                <option value="new">New</option>
                <option value="contacted">Contacted</option>
                <option value="converted">Converted</option>
              </select>
              <label className="inline-flex items-center gap-1.5 rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink">
                <input
                  type="checkbox"
                  checked={includeSpam}
                  onChange={(e) => setIncludeSpam(e.target.checked)}
                  className="size-4"
                />
                Show spam
              </label>
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-pill border border-cardline px-4 py-1.5 text-[13px] font-medium text-ink"
              >
                <Download className="size-4" /> Export CSV
              </button>
            </div>
          </div>

          {submissions.length === 0 ? (
            <p className="rounded-card border border-cardline bg-card px-5 py-8 text-center text-[13px] text-tertiary">
              No submissions yet. Share your page to start getting replies.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {submissions.map((s) => (
                <li key={s.id} className="rounded-card border border-cardline bg-card px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] text-tertiary">
                      {new Date(s.createdAt).toLocaleString()}
                      {s.spam ? " · flagged as spam" : ""}
                    </p>
                    <div className="flex items-center gap-2">
                      <select
                        value={s.status}
                        onChange={(e) => void handleUpdateSubmission(s, { status: e.target.value as FormSubmissionStatus })}
                        disabled={readOnly}
                        aria-label="Submission status"
                        className="rounded-lg border border-cardline bg-background px-2 py-1 text-[12px] text-ink"
                      >
                        {(Object.keys(STATUS_LABELS) as FormSubmissionStatus[]).map((st) => (
                          <option key={st} value={st}>{STATUS_LABELS[st]}</option>
                        ))}
                      </select>
                      {!readOnly && (
                        <button
                          type="button"
                          onClick={() => void handleDeleteSubmission(s.id)}
                          aria-label="Delete submission"
                          className="rounded-lg p-1.5 text-tertiary hover:text-red-700"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  <dl className="mt-2 flex flex-col gap-1">
                    {Object.entries(s.payload).map(([key, value]) => {
                      const label = form.fields.find((f) => f.id === key)?.label ?? key;
                      return (
                        <div key={key} className="text-sm">
                          <dt className="inline font-medium text-ink">{label}: </dt>
                          <dd className="inline whitespace-pre-wrap text-secondary">{value}</dd>
                        </div>
                      );
                    })}
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <label className="flex flex-1 flex-col gap-1">
                      <span className="text-[11px] font-medium text-tertiary">Notes</span>
                      <input
                        value={notesDraft[s.id] ?? s.notes ?? ""}
                        onChange={(e) => setNotesDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        onBlur={() => {
                          const draft = notesDraft[s.id];
                          if (draft !== undefined && draft !== (s.notes ?? "")) {
                            void handleUpdateSubmission(s, { notes: draft.trim() || null });
                          }
                        }}
                        disabled={readOnly}
                        placeholder="Private notes…"
                        className="rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] font-medium text-tertiary">Follow up</span>
                      <input
                        type="date"
                        value={followUpDraft[s.id] ?? (s.followUpAt ? s.followUpAt.slice(0, 10) : "")}
                        onChange={(e) => setFollowUpDraft((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        onBlur={() => {
                          const draft = followUpDraft[s.id];
                          if (draft !== undefined) {
                            const current = s.followUpAt ? s.followUpAt.slice(0, 10) : "";
                            if (draft !== current) {
                              void handleUpdateSubmission(s, {
                                followUpAt: draft ? new Date(`${draft}T09:00:00.000Z`).toISOString() : null,
                              });
                            }
                          }
                        }}
                        disabled={readOnly}
                        className="rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink"
                      />
                    </label>
                  </div>
                  {s.spam && !readOnly ? (
                    <button
                      type="button"
                      onClick={() => void handleUpdateSubmission(s, { spam: false })}
                      className="mt-2 text-[12px] font-medium text-accent underline"
                    >
                      Not spam — move to inbox
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {nextCursor ? (
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="self-center rounded-pill border border-cardline px-5 py-2 text-sm text-ink disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
          <p className="text-[11px] text-tertiary">
            Spam-flagged replies are hidden by default and never send a notification email.
            CSV export includes spam rows — you decide what to do with them.
          </p>
        </div>
      )}
    </div>
  );
}
