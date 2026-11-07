import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory, type TrpcContext } from "@kytelink/trpc";
import { getClickhouse } from "@kytelink/clickhouse";
import { loadConfig, setConfigForTest } from "../config";
import { logger } from "../logger";
import { createSeededStore, type MemoryStore } from "../store/memory-store";
import { appRouter } from "./index";

// ─── Forms router test ───────────────────────────────────────────────────────
// The generated Prisma client cannot be built locally (engine download is
// proxy-blocked), so the real @kytelink/db module cannot even be imported
// here. This test mocks it with a small in-memory stand-in and exercises the
// router end to end: access control via the seeded MemoryStore, the upsert /
// list / update / export procedures, and the raw-SQL search path (the fake
// $queryRaw decodes the bound parameters in the same order the router binds
// them, so a wrong binding order fails the test).

const { fakeDb, capturedSql } = vi.hoisted(() => {
  const forms: any[] = [];
  const submissions: any[] = [];
  const capturedSql: Array<{ values: unknown[] }> = [];

  function matchSubmission(row: any, where: any): boolean {
    if (where.formId !== undefined && row.formId !== where.formId) return false;
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.spam !== undefined && row.spam !== where.spam) return false;
    return true;
  }

  const fakeDb = {
    forms,
    submissions,
    formBlock: {
      findUnique: async ({ where }: any) =>
        forms.find((f) => (where.kyteId !== undefined ? f.kyteId === where.kyteId : f.id === where.id)) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = forms.find((f) => f.kyteId === where.kyteId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          ...create,
          id: `form_${forms.length + 1}`,
          endpointToken: `tok_${forms.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        forms.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = forms.find((f) => f.id === where.id);
        if (!row) throw new Error("form not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      deleteMany: async ({ where }: any) => {
        const doomed = forms.filter((f) => f.kyteId === where.kyteId);
        for (const f of doomed) {
          const i = submissions.findIndex((s) => s.formId === f.id);
          if (i >= 0) submissions.splice(i, 1);
          forms.splice(forms.indexOf(f), 1);
        }
        return { count: doomed.length };
      },
    },
    formSubmission: {
      count: async ({ where }: any) => submissions.filter((s) => matchSubmission(s, where)).length,
      groupBy: async ({ where }: any) => {
        const counts = new Map<string, number>();
        for (const s of submissions.filter((row) => matchSubmission(row, where))) {
          counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
        }
        return [...counts.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
      },
      findFirst: async ({ where }: any) =>
        submissions.find((s) => matchSubmission(s, where)) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        const rows = submissions.filter((s) => matchSubmission(s, where));
        if (orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows;
      },
      update: async ({ where, data }: any) => {
        const row = submissions.find((s) => s.id === where.id);
        if (!row) throw new Error("submission not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (let i = submissions.length - 1; i >= 0; i--) {
          if (matchSubmission(submissions[i], where)) {
            submissions.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
    },
    // Decodes the bound parameters in the order the router binds them:
    // [formId, status, status, includeSpam, search, search, search,
    //  cursor, cursor, limit] (status, search, and cursor each appear twice
    // in the template — once in the IS NULL guard, once in the comparison).
    $queryRaw: async (query: { values: unknown[] }) => {
      capturedSql.push(query);
      const [formId, status, , includeSpam, search, , , cursorAt, , limit] = query.values as [
        string,
        string | null,
        string | null,
        boolean,
        string | null,
        string | null,
        string | null,
        Date | null,
        Date | null,
        number,
      ];
      let rows = submissions.filter((s) => s.formId === formId);
      if (status !== null) rows = rows.filter((s) => s.status === status);
      if (!includeSpam) rows = rows.filter((s) => !s.spam);
      if (search !== null) {
        const term = search.replace(/^%|%$|\\%/g, "").replace(/\\(.)/g, "$1").toLowerCase();
        rows = rows.filter(
          (s) =>
            JSON.stringify(s.payload).toLowerCase().includes(term) ||
            (s.notes ?? "").toLowerCase().includes(term),
        );
      }
      if (cursorAt !== null) rows = rows.filter((s) => s.createdAt < cursorAt);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return rows.slice(0, limit);
    },
  };
  return { fakeDb, capturedSql };
});

vi.mock("@kytelink/db", () => ({
  getDb: () => fakeDb,
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  },
}));

const createCaller = createCallerFactory(appRouter);
const KYTE_ID = "kyte_agent_draft";

async function contextFor(store: MemoryStore, email: string): Promise<TrpcContext> {
  const user = await store.userByEmail(email);
  if (!user) throw new Error(`no fixture user ${email}`);
  return {
    session: {
      userId: user.id,
      email: user.email,
      isAdmin: user.role === "ADMIN",
      status: user.status,
    },
    user: { id: user.id, email: user.email },
    ip: "127.0.0.1",
    redis: null,
    db: store,
    ch: getClickhouse(),
    log: logger,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = createSeededStore();
  fakeDb.forms.length = 0;
  fakeDb.submissions.length = 0;
  capturedSql.length = 0;
  setConfigForTest(
    loadConfig({ ...process.env, ADMIN_EMAILS: "agent-admin@kytelink.dev", WEB_BASE_URL: "http://localhost:3000" }),
  );
});

const starterFields = [
  { id: "name", type: "text", label: "Name", required: true },
  { id: "email", type: "email", label: "Email", required: true },
  { id: "message", type: "textarea", label: "Message", required: true },
] as const;

async function ownerCaller() {
  return createCaller(await contextFor(store, "agent@kytelink.dev"));
}

function seedSubmission(overrides: Record<string, unknown> = {}) {
  const n = fakeDb.submissions.length + 1;
  const row = {
    id: `sub_${n}`,
    formId: "form_1",
    kyteId: KYTE_ID,
    orgId: "org_agent_personal",
    payload: { name: "Ada", email: "ada@example.com", message: "Hello!" },
    spam: false,
    status: "new",
    notes: null,
    followUpAt: null,
    createdAt: new Date(`2026-11-0${n}T12:00:00.000Z`),
    updatedAt: new Date(`2026-11-0${n}T12:00:00.000Z`),
    ...overrides,
  };
  fakeDb.submissions.push(row);
  return row;
}

describe("forms.getForm / upsertForm", () => {
  it("returns null before a form exists, then the upserted form with its endpoint", async () => {
    const caller = await ownerCaller();
    await expect(caller.forms.getForm({ kyteId: KYTE_ID })).resolves.toEqual({ form: null });

    const form = await caller.forms.upsertForm({
      kyteId: KYTE_ID,
      title: "Contact me",
      fields: [...starterFields],
    });
    expect(form.title).toBe("Contact me");
    expect(form.endpointPath).toBe(`/forms/submit/${form.endpointToken}`);
    expect(form.fields).toHaveLength(3);

    const again = await caller.forms.getForm({ kyteId: KYTE_ID });
    expect(again.form?.id).toBe(form.id);
    expect(again.form?.submissionCount).toBe(0);
  });

  it("rejects a file field at the input boundary — deferred, no $0 storage", async () => {
    const caller = await ownerCaller();
    await expect(
      caller.forms.upsertForm({
        kyteId: KYTE_ID,
        fields: [{ id: "upload", type: "file", label: "Upload" }] as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a viewer the write (read-only role cannot upsert)", async () => {
    const viewer = createCaller(await contextFor(store, "viewer@kytelink.dev"));
    await expect(
      viewer.forms.upsertForm({ kyteId: "kyte_ag_1", fields: [...starterFields] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rotates the endpoint token and the old path stops being the current one", async () => {
    const caller = await ownerCaller();
    const form = await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    const rotated = await caller.forms.regenerateEndpoint({ kyteId: KYTE_ID });
    expect(rotated.endpointToken).not.toBe(form.endpointToken);
    expect(rotated.endpointPath).toBe(`/forms/submit/${rotated.endpointToken}`);
  });
});

describe("forms inbox", () => {
  it("lists submissions newest-first with per-status counts", async () => {
    const caller = await ownerCaller();
    await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    seedSubmission({ status: "new" });
    seedSubmission({ status: "contacted" });
    seedSubmission({ status: "converted" });
    seedSubmission({ status: "new", spam: true });

    const page = await caller.forms.listSubmissions({ kyteId: KYTE_ID });
    expect(page.submissions).toHaveLength(3); // spam hidden by default
    expect(page.submissions[0]?.payload.name).toBe("Ada");
    expect(page.counts).toEqual({ new: 2, contacted: 1, converted: 1, spam: 1, total: 4 });
    expect(page.nextCursor).toBeNull();

    const withSpam = await caller.forms.listSubmissions({ kyteId: KYTE_ID, includeSpam: true });
    expect(withSpam.submissions).toHaveLength(4);
  });

  it("searches answers and notes, and binds the LIKE pattern safely", async () => {
    const caller = await ownerCaller();
    await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    seedSubmission({ payload: { name: "Ada Lovelace", email: "ada@example.com", message: "Hi" } });
    seedSubmission({ payload: { name: "Grace", email: "grace@example.com", message: "Hi" }, notes: "met at the Ada conf" });

    const page = await caller.forms.listSubmissions({ kyteId: KYTE_ID, search: "ada" });
    expect(page.submissions).toHaveLength(2); // name match + notes match

    const lastQuery = capturedSql[capturedSql.length - 1]!;
    expect(lastQuery.values[4]).toBe("%ada%"); // search bound as a LIKE pattern
    expect(lastQuery.values[1]).toBeNull(); // no status filter
  });

  it("filters by status and paginates on the createdAt cursor", async () => {
    const caller = await ownerCaller();
    await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    seedSubmission({ status: "new" });
    seedSubmission({ status: "new" });
    seedSubmission({ status: "contacted" });

    const first = await caller.forms.listSubmissions({ kyteId: KYTE_ID, status: "new", limit: 1 });
    expect(first.submissions).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await caller.forms.listSubmissions({
      kyteId: KYTE_ID,
      status: "new",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.submissions).toHaveLength(1);
    expect(second.submissions[0]?.id).not.toBe(first.submissions[0]?.id);
    expect(second.nextCursor).toBeNull();
  });

  it("updates status, notes, and follow-up date, then deletes", async () => {
    const caller = await ownerCaller();
    await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    const row = seedSubmission();

    const updated = await caller.forms.updateSubmission({
      kyteId: KYTE_ID,
      submissionId: row.id,
      status: "contacted",
      notes: "Emailed back.",
      followUpAt: "2026-11-10T09:00:00.000Z",
    });
    expect(updated.submission.status).toBe("contacted");
    expect(updated.submission.notes).toBe("Emailed back.");
    expect(updated.submission.followUpAt).toBe("2026-11-10T09:00:00.000Z");

    const fetched = await caller.forms.getSubmission({ kyteId: KYTE_ID, submissionId: row.id });
    expect(fetched.submission.status).toBe("contacted");

    await caller.forms.deleteSubmission({ kyteId: KYTE_ID, submissionId: row.id });
    await expect(
      caller.forms.getSubmission({ kyteId: KYTE_ID, submissionId: row.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("exports CSV with field columns in order, including spam rows", async () => {
    const caller = await ownerCaller();
    await caller.forms.upsertForm({ kyteId: KYTE_ID, fields: [...starterFields] });
    seedSubmission({ payload: { name: "Ada", email: "ada@example.com", message: "Hello, world" } });
    seedSubmission({ status: "new", spam: true, payload: { name: "Bot", email: "bot@spam.example", message: "buy now" } });

    const { csv, filename } = await caller.forms.exportCsv({ kyteId: KYTE_ID });
    expect(filename).toMatch(/form-submissions\.csv$/);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("submitted_at,status,spam,Name,Email,Message,notes,follow_up_at");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(",yes,Bot,bot@spam.example,buy now,,");
  });
});
