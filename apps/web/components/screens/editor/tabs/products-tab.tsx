import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor } from "../../../../lib/editor/editor-context";
import { useApp } from "../../../../lib/app-context";
import type {
  CommerceProduct as Product,
  CommerceSale as Sale,
  ConnectStatus,
  Tip,
} from "../../../../lib/api/client-interface";
import { emptyTipJar } from "@kytelink/schemas";
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
  const { kyte, allows, draft, patchDraft } = useEditor();
  const { api, toast } = useApp();
  const readOnly = !allows("edit_draft");

  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [totals, setTotals] = useState({ grossCents: 0, feesCents: 0, netCents: 0, count: 0 });
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [tips, setTips] = useState<Tip[]>([]);
  const [tipTotals, setTipTotals] = useState({ grossCents: 0, feesCents: 0, netCents: 0, count: 0 });

  // Tip jar form state (saved into the page draft on Save, like booking blocks).
  const [tipHeading, setTipHeading] = useState("");
  const [tipMessage, setTipMessage] = useState("");
  const [tipAmounts, setTipAmounts] = useState("");
  const [tipFormError, setTipFormError] = useState<string | null>(null);

  // Keep the jar form in sync with the draft (e.g. after publish or revert).
  useEffect(() => {
    const jar = draft.tipJar;
    setTipHeading(jar?.heading ?? "");
    setTipMessage(jar?.message ?? "");
    setTipAmounts(jar ? jar.amountsCents.map((c) => (c / 100).toFixed(2)).join(", ") : "");
    setTipFormError(null);
  }, [draft.tipJar]);

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
      const [p, s, c, t] = await Promise.all([
        api.commerce.listProducts({ kyteId: kyte.id }),
        api.commerce.getSales({ kyteId: kyte.id, limit: 50 }),
        api.commerce.getConnectStatus({ kyteId: kyte.id }),
        api.tipJar.listTips({ kyteId: kyte.id, limit: 50 }),
      ]);
      setProducts(p.products);
      setSales(s.sales);
      setTotals(s.totals);
      setConnect(c);
      setTips(t.tips);
      setTipTotals(t.totals);
    } catch (error) {
      toast("Couldn't load your products.", "error");
    } finally {
      setLoading(false);
    }
  }, [api, kyte.id, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // After returning from Stripe's hosted onboarding, say so plainly and clear
  // the ?stripe= flag so a refresh doesn't repeat the message. The status
  // above is already re-fetched on mount, so this is confirmation only.
  const stripeReturnHandled = useRef(false);
  useEffect(() => {
    if (stripeReturnHandled.current) return;
    stripeReturnHandled.current = true;
    const flag = new URLSearchParams(window.location.search).get("stripe");
    if (flag === "done") {
      toast("Welcome back — checking your Stripe status…", "success");
    } else if (flag === "refresh") {
      toast("Let's finish your Stripe setup — pick up where you left off.", "default");
    }
    if (flag) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [toast]);

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

  // ── Tip jar ──────────────────────────────────────────────────────────────
  // Config lives in the page draft (profileContent.tipJar) and publishes with
  // the page, like booking blocks. Tips are separate from product sales.

  function handleToggleTipJar() {
    if (readOnly) return;
    if (draft.tipJar) {
      patchDraft({ tipJar: null });
      toast("Tip jar removed from your page.", "success");
    } else {
      const jar = emptyTipJar();
      patchDraft({ tipJar: jar });
      setTipHeading(jar.heading);
      setTipMessage(jar.message ?? "");
      setTipAmounts(jar.amountsCents.map((c) => (c / 100).toFixed(2)).join(", "));
    }
  }

  function handleSaveTipJar() {
    setTipFormError(null);
    if (!tipHeading.trim()) {
      setTipFormError("Give your tip jar a heading.");
      return;
    }
    const amounts = tipAmounts
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Math.round(Number(s) * 100));
    if (amounts.length === 0 || amounts.length > 5) {
      setTipFormError("Add 1 to 5 amounts, separated by commas.");
      return;
    }
    if (amounts.some((c) => !Number.isFinite(c) || c < 50 || c > 1_000_000)) {
      setTipFormError("Each amount must be between $0.50 and $10,000.");
      return;
    }
    const sorted = [...amounts].sort((a, b) => a - b);
    if (new Set(sorted).size !== sorted.length) {
      setTipFormError("Amounts must be different from each other.");
      return;
    }
    patchDraft({
      tipJar: {
        heading: tipHeading.trim(),
        message: tipMessage.trim() || undefined,
        amountsCents: sorted,
        active: true,
      },
    });
    toast("Tip jar saved to your draft. Publish to make it live.", "success");
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
        ) : !connect.connected ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Connect your Stripe account to start selling. FreeTree takes 4% of what's
              left after Stripe's processing fee (on a $100 sale, about $3.87). No monthly
              fees, ever.
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
        ) : (
          <>
            {/* Status checklist — sellers check readiness here in FreeTree,
                not by opening the Stripe dashboard. */}
            <ul className="mt-3 flex flex-col gap-1.5 text-sm">
              <li>
                <span className="text-green-700">✓</span> Stripe account connected
              </li>
              <li>
                {connect.chargesEnabled ? (
                  <>
                    <span className="text-green-700">✓</span> Ready to take payments
                  </>
                ) : (
                  <>
                    <span className="text-amber-600">…</span> Ready to take payments — Stripe is
                    still checking your details
                  </>
                )}
              </li>
              <li>
                {connect.payoutsEnabled ? (
                  <>
                    <span className="text-green-700">✓</span> Payouts set up
                  </>
                ) : (
                  <>
                    <span className="text-amber-600">…</span> Payouts — add your bank details in
                    Stripe to get paid
                  </>
                )}
              </li>
            </ul>
            {connect.chargesEnabled ? (
              <p className="mt-2 text-sm text-green-700">
                ✓ You're ready to sell. FreeTree takes 4% of what's left after Stripe's fee.
              </p>
            ) : (
              <>
                <p className="mt-2 text-sm text-muted-foreground">
                  You're connected. Stripe is still checking your details — this usually
                  takes a few minutes. If Stripe needs anything else, pick up where you left
                  off below.
                </p>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={handleConnectStripe}
                    className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-[#1B4332] px-4 text-sm font-semibold text-[#FDF8F0] hover:opacity-90"
                  >
                    <ExternalLink className="size-4" />
                    Continue Stripe setup
                  </button>
                )}
              </>
            )}
            {/* Payouts live in Stripe — deep-link straight to the payouts page,
                not the dashboard home, so sellers never have to hunt for it. */}
            <a
              href="https://dashboard.stripe.com/payouts"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[#1B4332] underline underline-offset-2 hover:opacity-80"
            >
              {connect.payoutsEnabled ? "View payouts in Stripe" : "Set up payouts in Stripe"}
              <ExternalLink className="size-3.5" />
            </a>
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

      {/* ── Tip jar ── */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Tip jar</h2>
          {!readOnly && (
            <button
              type="button"
              onClick={handleToggleTipJar}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-accent-border bg-accent-soft px-3 text-sm font-medium hover:bg-accent-soft/70"
            >
              {draft.tipJar ? "Remove tip jar" : "Add tip jar"}
            </button>
          )}
        </div>
        {!draft.tipJar ? (
          <p className="text-sm text-muted-foreground">
            Let visitors send you a tip with no product to buy — preset amounts, same
            4%-on-net fee as a sale. It shows on your page after you publish.
          </p>
        ) : (
          <div className="flex flex-col gap-3 rounded-card border p-4">
            {tipFormError && (
              <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {tipFormError}
              </p>
            )}
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Heading</span>
              <input
                type="text"
                value={tipHeading}
                onChange={(e) => setTipHeading(e.target.value)}
                maxLength={120}
                disabled={readOnly}
                className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                placeholder="Leave a tip"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Message (optional)</span>
              <input
                type="text"
                value={tipMessage}
                onChange={(e) => setTipMessage(e.target.value)}
                maxLength={500}
                disabled={readOnly}
                className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                placeholder="Support my work"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Amounts (dollars, comma-separated)</span>
              <input
                type="text"
                value={tipAmounts}
                onChange={(e) => setTipAmounts(e.target.value)}
                disabled={readOnly}
                className="w-full rounded-lg border px-3 py-2 text-sm disabled:opacity-60"
                placeholder="3, 5, 10"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                1 to 5 amounts, $0.50 to $10,000 each. Visitors pick one at checkout.
              </span>
            </label>
            {!readOnly && (
              <div>
                <button
                  type="button"
                  onClick={handleSaveTipJar}
                  className="rounded-lg bg-[#1B4332] px-4 py-2 text-sm font-semibold text-[#FDF8F0]"
                >
                  Save tip jar
                </button>
              </div>
            )}
            {tipTotals.count > 0 && (
              <div className="mt-1 border-t pt-3">
                <p className="text-sm font-medium">
                  {tipTotals.count} {tipTotals.count === 1 ? "tip" : "tips"} ·{" "}
                  {formatProductPrice(tipTotals.grossCents, "usd")} total · you keep{" "}
                  {formatProductPrice(tipTotals.netCents, "usd")}
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  {tips.map((tip) => (
                    <div key={tip.id} className="flex items-center justify-between text-sm">
                      <div>
                        <p className="font-medium">
                          {formatProductPrice(tip.amountCents, tip.currency)}
                          {tip.tipMessage ? ` — “${tip.tipMessage}”` : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tip.buyerEmail ?? "Guest"} ·{" "}
                          {new Date(tip.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        You keep {formatProductPrice(tip.amountCents - tip.feeCents, tip.currency)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
