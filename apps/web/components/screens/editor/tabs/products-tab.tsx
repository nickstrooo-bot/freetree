import { useCallback, useEffect, useState } from "react";
import { useEditor } from "../../../../lib/editor/editor-context";
import { useApp } from "../../../../lib/app-context";
import type {
  CommerceProduct as Product,
  CommerceSale as Sale,
  ConnectStatus,
} from "../../../../lib/api/client-interface";
import { formatProductPrice } from "@kytelink/ui";
import { Plus, Trash2, Pencil, ExternalLink } from "lucide-react";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:…;base64, prefix
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

export function ProductsTab() {
  const { kyte, allows } = useEditor();
  const { api, toast } = useApp();
  const readOnly = !allows("edit_draft");

  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [totals, setTotals] = useState({ grossCents: 0, feesCents: 0, netCents: 0, count: 0 });
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // Add/edit form state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [allowPromoCodes, setAllowPromoCodes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, s, c] = await Promise.all([
        api.commerce.listProducts({ kyteId: kyte.id }),
        api.commerce.getSales({ kyteId: kyte.id, limit: 50 }),
        api.commerce.getConnectStatus({ kyteId: kyte.id }),
      ]);
      setProducts(p.products);
      setSales(s.sales);
      setTotals(s.totals);
      setConnect(c);
    } catch (error) {
      toast("Couldn't load your products.", "error");
    } finally {
      setLoading(false);
    }
  }, [api, kyte.id, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleConnectStripe() {
    try {
      const returnUrl = `${window.location.origin}/edit/products?stripe=done`;
      const refreshUrl = `${window.location.origin}/edit/products?stripe=refresh`;
      const { url } = await api.commerce.createOnboardingLink({
        kyteId: kyte.id,
        returnUrl,
        refreshUrl,
      });
      window.location.href = url;
    } catch {
      toast("Couldn't start Stripe setup. Is Stripe configured?", "error");
    }
  }

  function openAddForm() {
    setEditing(null);
    setName("");
    setDescription("");
    setPrice("");
    setFile(null);
    setExternalUrl("");
    setAllowPromoCodes(false);
    setFormError(null);
    setFormOpen(true);
  }

  function openEditForm(product: Product) {
    setEditing(product);
    setName(product.name);
    setDescription(product.description ?? "");
    setPrice((product.priceCents / 100).toFixed(2));
    setFile(null);
    setExternalUrl(product.externalUrl ?? "");
    setAllowPromoCodes(product.allowPromoCodes ?? false);
    setFormError(null);
    setFormOpen(true);
  }

  async function handleSave() {
    setFormError(null);
    const priceCents = Math.round(Number(price) * 100);
    if (!name.trim()) {
      setFormError("Give your product a name.");
      return;
    }
    if (!Number.isFinite(priceCents) || priceCents < 50) {
      setFormError("Price must be at least $0.50.");
      return;
    }
    if (!file && !externalUrl.trim() && !editing?.hasFile && !editing?.externalUrl) {
      setFormError("Upload a file or paste a download link.");
      return;
    }
    setSaving(true);
    try {
      let fileBase64: string | undefined;
      let fileName: string | undefined;
      if (file) {
        if (file.size > 25 * 1024 * 1024) {
          setFormError("File must be under 25MB.");
          setSaving(false);
          return;
        }
        fileBase64 = await fileToBase64(file);
        fileName = file.name;
      }
      if (editing) {
        await api.commerce.updateProduct({
          kyteId: kyte.id,
          productId: editing.id,
          name: name.trim(),
          description: description.trim() || null,
          priceCents,
          ...(fileBase64 ? { fileBase64, fileName } : {}),
          externalUrl: externalUrl.trim() || null,
          allowPromoCodes,
        });
        toast("Product updated.", "success");
      } else {
        await api.commerce.createProduct({
          kyteId: kyte.id,
          name: name.trim(),
          description: description.trim() || undefined,
          priceCents,
          fileBase64,
          fileName,
          externalUrl: externalUrl.trim() || undefined,
          allowPromoCodes,
        });
        toast("Product added.", "success");
      }
      setFormOpen(false);
      await refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Couldn't save that product.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(product: Product) {
    if (!window.confirm(`Delete "${product.name}"? This can't be undone.`)) return;
    try {
      await api.commerce.deleteProduct({ kyteId: kyte.id, productId: product.id });
      toast("Product deleted.", "success");
      await refresh();
    } catch {
      toast("Couldn't delete that product.", "error");
    }
  }

  async function handleToggleActive(product: Product) {
    try {
      await api.commerce.updateProduct({
        kyteId: kyte.id,
        productId: product.id,
        active: !product.active,
      });
      await refresh();
    } catch {
      toast("Couldn't update that product.", "error");
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading your products…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Stripe Connect status ── */}
      <section className="rounded-card border border-accent-border bg-accent-soft p-4">
        <h2 className="text-base font-semibold">Selling setup</h2>
        {!connect?.configured ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Payments aren't configured on this FreeTree yet. Selling will be available soon.
          </p>
        ) : connect.connected && connect.chargesEnabled ? (
          <p className="mt-2 text-sm text-green-700">
            ✓ Stripe connected — you're ready to sell. You keep 96% of every sale.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Connect your Stripe account to start selling. FreeTree takes 4% of each sale —
              you keep 96%. No monthly fees, ever.
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={handleConnectStripe}
                className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-[#1B4332] px-4 text-sm font-semibold text-[#FDF8F0] hover:opacity-90"
              >
                <ExternalLink className="size-4" />
                Connect Stripe
              </button>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          You're responsible for your own taxes on sales. FreeTree doesn't issue tax documents.
        </p>
      </section>

      {/* ── Earnings summary ── */}
      {totals.count > 0 && (
        <section className="grid grid-cols-3 gap-3">
          <div className="rounded-card border p-3 text-center">
            <p className="text-xs text-muted-foreground">Sales</p>
            <p className="text-lg font-bold">{totals.count}</p>
          </div>
          <div className="rounded-card border p-3 text-center">
            <p className="text-xs text-muted-foreground">Gross</p>
            <p className="text-lg font-bold">{formatProductPrice(totals.grossCents, "usd")}</p>
          </div>
          <div className="rounded-card border p-3 text-center">
            <p className="text-xs text-muted-foreground">You keep</p>
            <p className="text-lg font-bold text-green-700">{formatProductPrice(totals.netCents, "usd")}</p>
          </div>
        </section>
      )}

      {/* ── Product list ── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Products</h2>
          {!readOnly && (
            <button
              type="button"
              onClick={openAddForm}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-accent-border bg-accent-soft px-3 text-sm font-medium hover:bg-accent-soft/70"
            >
              <Plus className="size-4" />
              Add product
            </button>
          )}
        </div>

        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No products yet. Add your first digital product — a preset pack, a PDF guide, a
            template — and start selling from your page.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {products.map((product) => (
              <div
                key={product.id}
                className={`rounded-card border p-4 ${product.active ? "" : "opacity-60"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {product.name}
                      {!product.active && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">(hidden)</span>
                      )}
                    </p>
                    <p className="text-sm font-medium text-green-700">
                      {formatProductPrice(product.priceCents, product.currency)}
                    </p>
                    {product.description && (
                      <p className="mt-1 truncate text-sm text-muted-foreground">{product.description}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {product.hasFile ? `📎 ${product.fileName}` : product.externalUrl ? "🔗 External link" : "No file"}
                      {product.allowPromoCodes ? " · 🏷️ Promo codes" : ""}
                    </p>
                  </div>
                  {!readOnly && (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => openEditForm(product)}
                        aria-label={`Edit ${product.name}`}
                        className="rounded-lg border p-2 hover:bg-accent-soft"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleActive(product)}
                        aria-label={product.active ? `Hide ${product.name}` : `Show ${product.name}`}
                        className="rounded-lg border p-2 text-xs font-medium hover:bg-accent-soft"
                      >
                        {product.active ? "Hide" : "Show"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(product)}
                        aria-label={`Delete ${product.name}`}
                        className="rounded-lg border p-2 text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Sales history ── */}
      {sales.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold">Recent sales</h2>
          <div className="flex flex-col gap-2">
            {sales.map((sale) => (
              <div key={sale.id} className="flex items-center justify-between rounded-card border px-4 py-3 text-sm">
                <div>
                  <p className="font-medium">{sale.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    {sale.buyerEmail ?? "Guest"} · {new Date(sale.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{formatProductPrice(sale.amountCents, sale.currency)}</p>
                  <p className="text-xs text-muted-foreground">
                    You keep {formatProductPrice(sale.amountCents - sale.feeCents, sale.currency)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Add/edit modal ── */}
      {formOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={editing ? "Edit product" : "Add product"}
        >
          <div className="w-full max-w-md rounded-card bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">{editing ? "Edit product" : "Add product"}</h3>
            {formError && (
              <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {formError}
              </p>
            )}
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="Lightroom Preset Pack"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={3}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="What's inside? Who's it for?"
              />
            </label>
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium">Price (USD)</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                min="0.50"
                step="0.01"
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="20.00"
              />
            </label>
            <div className="mb-3">
              <span className="mb-1 block text-sm font-medium">Digital file (max 25MB)</span>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm"
              />
              {editing?.hasFile && !file && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Current file: {editing.fileName} (upload a new one to replace it)
                </p>
              )}
            </div>
            <label className="mb-4 block">
              <span className="mb-1 block text-sm font-medium">Or external download URL</span>
              <input
                type="url"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                placeholder="https://…"
              />
            </label>
            <label className="mb-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={allowPromoCodes}
                onChange={(e) => setAllowPromoCodes(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[#1B4332]"
              />
              <span>
                <span className="block text-sm font-medium">Allow promo codes at checkout</span>
                <span className="block text-xs text-muted-foreground">
                  Buyers can enter a discount code. You create the codes in your Stripe
                  dashboard (Billing → Coupons).
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="rounded-lg border px-4 py-2 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="rounded-lg bg-[#1B4332] px-4 py-2 text-sm font-semibold text-[#FDF8F0] disabled:opacity-60"
              >
                {saving ? "Saving…" : editing ? "Save changes" : "Add product"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
