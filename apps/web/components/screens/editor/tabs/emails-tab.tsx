import { useCallback, useEffect, useState } from "react";
import { useEditor } from "../../../../lib/editor/editor-context";
import { useApp } from "../../../../lib/app-context";
import type { EmailCaptureBlock, EmailSubscriber } from "../../../../lib/api/client-interface";
import { Plus, Trash2, Download, Mail } from "lucide-react";

type StatusFilter = "confirmed" | "pending" | "unsubscribed" | "all";

export function EmailsTab() {
  const { kyte, allows } = useEditor();
  const { api, toast } = useApp();
  const readOnly = !allows("edit_draft");

  const [block, setBlock] = useState<EmailCaptureBlock | null>(null);
  const [subscribers, setSubscribers] = useState<EmailSubscriber[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("confirmed");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Block form state
  const [formOpen, setFormOpen] = useState(false);
  const [heading, setHeading] = useState("Join my email list");
  const [description, setDescription] = useState("");
  const [buttonText, setButtonText] = useState("Subscribe");
  const [active, setActive] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [b, s] = await Promise.all([
        api.emailCapture.getBlock({ kyteId: kyte.id }),
        api.emailCapture
          .listSubscribers({ kyteId: kyte.id, status: statusFilter, limit: 200 })
          .catch(() => ({ subscribers: [], nextCursor: null })),
      ]);
      setBlock(b.block);
      setSubscribers(s.subscribers);
      if (b.block) {
        setHeading(b.block.heading);
        setDescription(b.block.description ?? "");
        setButtonText(b.block.buttonText);
        setActive(b.block.active);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't load email list.", "error");
    } finally {
      setLoading(false);
    }
  }, [api, kyte.id, statusFilter, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.emailCapture.upsertBlock({
        kyteId: kyte.id,
        heading: heading.trim() || "Join my email list",
        description: description.trim() || null,
        buttonText: buttonText.trim() || "Subscribe",
        active,
      });
      setBlock(updated);
      setFormOpen(false);
      toast("Email signup block saved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteBlock() {
    if (!window.confirm("Remove the email signup block? Your subscriber list will be deleted too.")) return;
    try {
      await api.emailCapture.deleteBlock({ kyteId: kyte.id });
      setBlock(null);
      setSubscribers([]);
      toast("Email signup block removed.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
  }

  async function handleDeleteSubscriber(id: string) {
    try {
      await api.emailCapture.deleteSubscriber({ kyteId: kyte.id, subscriberId: id });
      setSubscribers((prev) => prev.filter((s) => s.id !== id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't delete.", "error");
    }
  }

  async function handleExport() {
    try {
      const { csv, filename } = await api.emailCapture.exportCsv({ kyteId: kyte.id });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Subscriber list downloaded.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't export.", "error");
    }
  }

  if (loading) {
    return <p className="text-sm text-tertiary">Loading your email list…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Email list</h2>
        <p className="mt-0.5 text-[13px] text-tertiary">
          Collect emails right on your page — free forever. Linktree charges $15/mo for this.
        </p>
      </div>

      {!block && !formOpen ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-cardline bg-card px-6 py-12 text-center">
          <Mail className="size-8 text-tertiary" aria-hidden="true" />
          <p className="max-w-sm text-[13px] text-secondary">
            Add an email signup block to your page and start building your list.
            Double opt-in is on by default — subscribers confirm before they're added.
          </p>
          {!readOnly ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="mt-1 inline-flex items-center gap-2 rounded-pill bg-accent px-5 py-2.5 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
            >
              <Plus className="size-4" /> Add email signup
            </button>
          ) : null}
        </div>
      ) : null}

      {formOpen || (block && !formOpen) ? null : null}

      {(formOpen || block) && (
        <form onSubmit={handleSave} className="flex flex-col gap-4 rounded-card border border-cardline bg-card p-5">
          <h3 className="text-sm font-semibold text-ink">
            {block ? "Signup block settings" : "New signup block"}
          </h3>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Heading</span>
            <input
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
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
              rows={3}
              disabled={readOnly}
              className="rounded-lg border border-cardline bg-background px-3 py-2 text-sm text-ink"
            />
          </label>
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
          {!readOnly && (
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-pill bg-accent px-5 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60"
              >
                {saving ? "Saving…" : block ? "Save changes" : "Add to my page"}
              </button>
              {formOpen && !block && (
                <button
                  type="button"
                  onClick={() => setFormOpen(false)}
                  className="rounded-pill border border-cardline px-5 py-2 text-sm text-ink"
                >
                  Cancel
                </button>
              )}
              {block && (
                <button
                  type="button"
                  onClick={handleDeleteBlock}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-pill border border-red-200 px-4 py-2 text-sm text-red-700"
                >
                  <Trash2 className="size-4" /> Remove
                </button>
              )}
            </div>
          )}
        </form>
      )}

      {block && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">
              Subscribers ({block.subscriberCount} confirmed)
            </h3>
            <div className="flex gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-cardline bg-background px-2 py-1.5 text-[13px] text-ink"
                aria-label="Filter by status"
              >
                <option value="confirmed">Confirmed</option>
                <option value="pending">Pending</option>
                <option value="unsubscribed">Unsubscribed</option>
                <option value="all">All</option>
              </select>
              <button
                type="button"
                onClick={handleExport}
                className="inline-flex items-center gap-1.5 rounded-pill border border-cardline px-4 py-1.5 text-[13px] font-medium text-ink"
              >
                <Download className="size-4" /> Export CSV
              </button>
            </div>
          </div>

          {subscribers.length === 0 ? (
            <p className="rounded-card border border-cardline bg-card px-5 py-8 text-center text-[13px] text-tertiary">
              No {statusFilter === "all" ? "" : statusFilter + " "}subscribers yet.
              {statusFilter === "confirmed" ? " Share your page to start building your list." : ""}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-cardline rounded-card border border-cardline bg-card">
              {subscribers.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{s.email}</p>
                    <p className="text-[11px] text-tertiary">
                      {s.status}
                      {s.confirmedAt ? ` · confirmed ${new Date(s.confirmedAt).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => handleDeleteSubscriber(s.id)}
                      aria-label={`Remove ${s.email}`}
                      className="rounded-lg p-1.5 text-tertiary hover:text-red-700"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-tertiary">
            Only confirmed subscribers export to CSV. Pending ones never opted in.
            Every subscriber gets a one-click unsubscribe link — no exceptions.
          </p>
        </div>
      )}
    </div>
  );
}
