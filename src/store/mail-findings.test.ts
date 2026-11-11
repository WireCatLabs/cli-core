import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { parseMailFindingsJson, readMailFindingsJson } from "../cli/findings-input.js"
import { formatLocator } from "../domain/locator.js"
import {
  MAIL_FINDING_FIELDS,
  type MailFinding,
  type MailFindingsInput,
  mailFindingFieldsHelp,
} from "../mail/findings.js"
import { proposalRegistry } from "../services/proposals/registry.js"
import type { EmailInput } from "./index.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const MINE: AccountKey = { provider: "email", account: "me@example.com" }
const agent = { bot: "mail-triage", model: "synthetic" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const email = (id: string, fields: Partial<EmailInput> = {}): EmailInput => ({
  externalId: `<${id}@example.com>`,
  subject: id,
  from: { address: "ann@example.com", name: "Ann" },
  to: [{ address: MINE.account, name: "Me" }],
  sentAt: Date.now(),
  receivedAt: Date.now(),
  bodyText: `text of ${id}`,
  ...fields,
})

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "mail-findings-")), "store.db") })
  stores.push(store)
  const accountId = await store.accounts.saveAccount(MINE, { name: null })
  const save = (thread: string, ...emails: EmailInput[]) =>
    store.mail.saveThread({ accountId, externalId: thread, now: Date.now(), emails })
  await save(
    "t-lease",
    email("lease", { bodyText: "Please sign the lease.\n-- \nAnn Lessor, Harbour Lettings" }),
    email("reply", { from: { address: MINE.account, name: "Me" }, outgoing: true }),
  )
  await save("t-big", email("big", { metadata: { partial: { bytes: 10 } } }))
  for (let n = 0; n < 6; n++) await save(`t-${n}`, email(`ask-${n}`))
  const ref = (thread: string, id: string) =>
    formatLocator({ provider: "email", account: MINE.account, chat: thread, message: `<${id}@example.com>` })
  const cite = async (thread: string, id: string) => {
    const marks = await store.mail.emailMarks(accountId, [`<${id}@example.com>`])
    return { reference: ref(thread, id), fingerprint: marks.get(`<${id}@example.com>`)?.fingerprint as string }
  }
  const project = await store.knowledge.addProject({ name: "Flat" })
  const batch = async (findings: MailFinding[], key = "mail-triage:7"): Promise<MailFindingsInput> => ({
    schemaVersion: 1,
    key,
    extractor: "synthetic",
    findings,
  })
  const task = async (id: string, cited = ["t-lease", "lease"] as const): Promise<MailFinding> => ({
    id,
    kind: "task",
    type: "chore",
    title: `Send the signed lease ${id}`,
    reason: "Ann asks for it",
    commitment: "explicit",
    evidence: [await cite(...cited)],
  })
  return { store, accountId, cite, ref, project, batch, task }
}

it("stages a run's cited findings once per key, and refuses the key reused for other input", async () => {
  const f = await fixture()
  const input = await f.batch([await f.task("t1")])

  const staged = await f.store.mailFindings.stage(MINE, input, agent)

  expect(staged).toMatchObject({ account: MINE, status: "proposed", receipt: null })
  expect((await f.store.mailFindings.stage(MINE, input, agent)).id).toBe(staged.id)
  await expect(f.store.mailFindings.stage(MINE, { ...input, extractor: "other" }, agent)).rejects.toThrow(
    "already used",
  )
  expect((await f.store.mailFindings.list({ account: MINE, status: "proposed" })).items.map((one) => one.id)).toEqual([
    staged.id,
  ])
})

it("refuses mail that changed, partial mail, a finding citing nothing, and more than five from one sender", async () => {
  const f = await fixture()
  const stage = async (findings: MailFinding[]) => f.store.mailFindings.stage(MINE, await f.batch(findings), agent)
  const changed = {
    ...(await f.task("t1")),
    evidence: [{ ...(await f.cite("t-lease", "lease")), fingerprint: "0".repeat(64) }],
  }
  const partial = { ...(await f.task("t1")), evidence: [await f.cite("t-big", "big")] }

  await expect(stage([changed as MailFinding])).rejects.toMatchObject({ details: { reason: "mail-findings.stale" } })
  const invented = {
    ...(await f.task("t1")),
    evidence: [{ reference: f.ref("t-lease", "never-sent"), fingerprint: "0".repeat(64) }],
  }
  await expect(stage([invented as MailFinding])).rejects.toMatchObject({
    code: "not_found",
    details: { reason: "mail-findings.not-stored" },
  })
  await expect(stage([partial as MailFinding])).rejects.toMatchObject({ details: { reason: "mail-findings.partial" } })
  await expect(stage([{ ...(await f.task("t1")), evidence: [] }])).rejects.toThrow("1–8 cited")
  await expect(
    stage([{ ...(await f.task("t1")), evidence: [{ reference: "msg:telegram/1/2/3", fingerprint: "a".repeat(64) }] }]),
  ).rejects.toThrow("msg:email")
  const flood = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => f.task(`t${n}`, [`t-${n}`, `ask-${n}`] as never)))
  await expect(stage(flood)).rejects.toThrow("more than 5 findings from ann@example.com")
  expect(await stage(flood.slice(0, 5))).toMatchObject({ status: "proposed" })
  const many = Array.from({ length: 31 }, (_, n) => ({ ...flood[0], id: `x${n}` }) as MailFinding)
  await expect(stage(many)).rejects.toThrow("1–30 mail findings")
  expect(() =>
    parseMailFindingsJson(JSON.stringify({ schema_version: 1, key: "no-run", extractor: "x", findings: [] })),
  ).toThrow()
})

it("lets only the owner decide, and makes each accepted finding where it belongs", async () => {
  const f = await fixture()
  const lease = [await f.cite("t-lease", "lease")]
  const first = await f.store.mailFindings.stage(MINE, await f.batch([await f.task("t1")]), agent)

  await expect(
    f.store.mailFindings.review(first.id, {
      fingerprint: first.fingerprint,
      accept: ["t1"],
      by: { bot: "another-agent", reason: "looks right" },
    }),
  ).rejects.toMatchObject({ code: "permission_error", details: { reason: "proposal.owner-only" } })
  const registry = proposalRegistry(f.store)
  const refused = await registry.decide([first.id], { confirm: true, by: { bot: "another-agent", reason: "ok" } })
  expect(refused.refused).toMatchObject([{ code: "permission_error", reason: "proposal.owner-only" }])
  expect((await registry.list({ kinds: ["mail_findings"], limit: 10, offset: 0 })).items).toMatchObject([
    { id: first.id, kind: "mail_findings", parts: [{ id: "t1", kind: "task" }] },
  ])

  const decided = await registry.decide([first.id], { confirm: true, by: "owner" })
  const taskRef = decided.decided[0]?.made[0] as string
  expect(taskRef).toMatch(/^task:/)
  const task = await f.store.tasks.details(taskRef)
  expect(task).toMatchObject({ status: "open" })

  const second = await f.store.mailFindings.stage(
    MINE,
    await f.batch(
      [
        {
          id: "u1",
          kind: "task_update",
          task: taskRef,
          change: "close",
          reason: "you replied",
          evidence: [await f.cite("t-lease", "reply")],
        },
        {
          id: "f1",
          kind: "fact",
          type: "decision",
          statement: "The lease starts in May",
          reason: "the lease says so",
          evidence: lease,
        },
        {
          id: "m1",
          kind: "memory",
          memoryKind: "summary",
          scope: "personal",
          body: "Ann rents the flat",
          project: f.project.ref,
          reason: "worth keeping",
          evidence: lease,
        },
        {
          id: "l1",
          kind: "link",
          from: "chat:email/me%40example.com/t-lease",
          to: f.project.ref,
          reason: "about the flat",
          evidence: lease,
        },
        {
          id: "c1",
          kind: "new_contact",
          address: "ann@example.com",
          name: "Ann Lessor",
          reason: "she wrote",
          evidence: lease,
        },
      ],
      "mail-triage:8",
    ),
    agent,
  )
  const reviewed = await f.store.mailFindings.review(second.id, {
    fingerprint: second.fingerprint,
    accept: ["u1", "f1", "m1", "l1", "c1"],
    by: "owner",
  })

  expect(reviewed.receipt?.items.map((one) => [one.id, one.status])).toEqual([
    ["u1", "accepted"],
    ["f1", "accepted"],
    ["m1", "accepted"],
    ["l1", "accepted"],
    ["c1", "accepted"],
  ])
  const made = Object.fromEntries((reviewed.receipt?.items ?? []).map((one) => [one.id, one.reference]))
  expect((await f.store.tasks.details(taskRef)).status).toBe("done")
  expect(made.f1).toMatch(/^fact:/)
  expect((await f.store.memories.get(made.m1 as string)).status).toBe("confirmed")
  expect(made.l1).toMatch(/^link:/)
  expect(made.c1).toMatch(/^person:/)
  expect((await f.store.people.personByUid((made.c1 as string).slice("person:".length)))?.name).toBe("Ann Lessor")
})

it("records invoices, payments, orders and certificate facts only when the owner accepts, and moves an order on", async () => {
  const f = await fixture()
  const shop = await f.store.knowledge.addOrganization({ kind: "company", name: "Shop One" })
  const cited = [await f.cite("t-lease", "lease")]
  const invoice: MailFinding = {
    id: "i1",
    kind: "invoice",
    direction: "payable",
    counterparty: shop.ref,
    currency: "EUR",
    lines: [{ description: "Desk", amount: "120.00" }],
    total: "120.00",
    number: "INV-7",
    dueDate: "2026-11-20",
    reason: "the shop bills the desk",
    evidence: cited,
  }
  const stage = async (findings: MailFinding[], key: string) =>
    f.store.mailFindings.stage(MINE, await f.batch(findings, key), agent)

  await expect(stage([{ ...invoice, total: "99.00" } as MailFinding], "mail-triage:20")).rejects.toMatchObject({
    details: { reason: "finance.total" },
  })
  await expect(
    stage(
      [
        {
          id: "o9",
          kind: "order_update",
          supplierName: "Shop One",
          number: "A-1",
          status: "shipped",
          reason: "x",
          evidence: cited,
        },
      ],
      "mail-triage:21",
    ),
  ).rejects.toMatchObject({ details: { reason: "order.not-found" } })

  const batch = await stage(
    [
      invoice,
      {
        id: "p1",
        kind: "payment",
        direction: "out",
        payee: shop.ref,
        amount: "120.00",
        currency: "EUR",
        date: "2026-11-05",
        reference: "receipt 55",
        reason: "the receipt for the desk",
        evidence: cited,
      },
      {
        id: "o1",
        kind: "order",
        purpose: "personal",
        supplier: shop.ref,
        supplierName: "Shop One",
        number: "A-1",
        total: "120.00",
        currency: "EUR",
        orderDate: "2026-11-04",
        reason: "the desk is ordered",
        evidence: cited,
      },
      {
        id: "f1",
        kind: "fact",
        type: "fact",
        statement: "Certificate 12-345 for the e-signature, account id 998, expires 2027-03-01",
        reason: "the issuer sent it",
        evidence: cited,
      },
    ],
    "mail-triage:22",
  )
  expect(await f.store.finance.invoices()).toEqual([])
  expect(await f.store.orders.list()).toEqual([])

  const reviewed = await f.store.mailFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["i1", "p1", "o1", "f1"],
    by: "owner",
  })
  const made = Object.fromEntries((reviewed.receipt?.items ?? []).map((one) => [one.id, one.reference]))
  expect(await f.store.finance.invoice(made.i1 as string)).toMatchObject({
    review: "confirmed",
    total: "120.00",
    number: "INV-7",
    evidence: [cited[0]?.reference],
  })
  expect(await f.store.finance.payment(made.p1 as string)).toMatchObject({ review: "confirmed", amount: "120.00" })
  const owner = (await f.store.orders.get(made.o1 as string)).customer
  expect(owner).toMatchObject({ owner: true })
  expect(await f.store.orders.get(made.o1 as string)).toMatchObject({
    purpose: "personal",
    status: "placed",
    total: "120.00",
    supplier: { ref: shop.ref },
    evidence: [cited[0]?.reference],
  })
  expect(made.f1).toMatch(/^fact:/)

  const shipped = [await f.cite("t-lease", "reply")]
  const update = await stage(
    [
      {
        id: "u1",
        kind: "order_update",
        supplierName: "shop one",
        number: "A-1",
        status: "delivered",
        date: "2026-11-06",
        reason: "the shop says it was delivered",
        evidence: shipped,
      },
    ],
    "mail-triage:23",
  )
  await f.store.mailFindings.review(update.id, { fingerprint: update.fingerprint, accept: ["u1"], by: "owner" })
  expect(await f.store.orders.get(made.o1 as string)).toMatchObject({
    status: "delivered",
    fulfilledDate: "2026-11-06",
    evidence: [cited[0]?.reference, shipped[0]?.reference],
  })
})

it("keeps a marketplace task's id and link, and an order's page, from the findings JSON to what accepting makes", async () => {
  const f = await fixture()
  const cited = await f.cite("t-lease", "lease")
  const json = (finding: Record<string, unknown>) =>
    JSON.stringify({ schema_version: 1, key: "mail-triage:30", extractor: "synthetic", findings: [finding] })
  const task = {
    id: "t1",
    kind: "task",
    type: "chore",
    title: "Reply on Avito to Ivan",
    reason: "Ivan asks about the café",
    commitment: "explicit",
    external_id: "Avito:4512345678",
    source_url: "https://www.avito.ru/profile/messenger/channel/u2i-abc",
    evidence: [cited],
  }
  expect(() => parseMailFindingsJson(json({ ...task, source_url: "javascript:alert(1)" }))).toThrow(/source URL/)
  expect(() => parseMailFindingsJson(json({ ...task, external_id: "4512345678" }))).toThrow(/<service>:<id>/)
  const order = {
    id: "o1",
    kind: "order",
    purpose: "personal",
    supplier_name: "Amazon.es",
    number: "406-3547475-4115561",
    source_url: "https://www.amazon.es/gp/your-account/order-details?orderID=406-3547475-4115561",
    reason: "the order is placed",
    evidence: [cited],
  }
  const input = parseMailFindingsJson(json(task))
  const batch = await f.store.mailFindings.stage(
    MINE,
    { ...input, findings: [...input.findings, ...parseMailFindingsJson(json(order)).findings] },
    agent,
  )

  const reviewed = await f.store.mailFindings.review(batch.id, {
    fingerprint: batch.fingerprint,
    accept: ["t1", "o1"],
    by: "owner",
  })
  const made = Object.fromEntries((reviewed.receipt?.items ?? []).map((one) => [one.id, one.reference]))
  expect(await f.store.tasks.details(made.t1 as string)).toMatchObject({
    externalId: "avito:4512345678",
    sourceUrl: "https://www.avito.ru/profile/messenger/channel/u2i-abc",
  })
  expect(await f.store.orders.get(made.o1 as string)).toMatchObject({ sourceUrl: order.source_url })
})

it("names the unknown or missing field, its finding and what that kind takes, as help lists it", async () => {
  const f = await fixture()
  const json = JSON.stringify({
    schema_version: 1,
    key: "mail-triage:40",
    extractor: "synthetic",
    findings: [
      {
        id: "f1",
        kind: "fact",
        type: "fact",
        statement: "x",
        reason: "r",
        expires_at: "2027-01-01",
        evidence: [await f.cite("t-lease", "lease")],
      },
    ],
  })
  expect(() => parseMailFindingsJson(json)).toThrow(
    expect.objectContaining({
      message: expect.stringMatching(/unknown mail finding field expires_at in f1 \(fact\); it takes id, kind, type/),
      details: expect.objectContaining({
        reason: "finding.unknown-field",
        fields: ["expires_at"],
        finding: "f1",
        kind: "fact",
        allowed: ["id", "kind", "type", "statement", "reason", "subject", "project", "evidence"],
      }),
    }),
  )
  const order = {
    schema_version: 1,
    key: "mail-triage:40",
    extractor: "synthetic",
    findings: [
      {
        id: "o1",
        kind: "order",
        purpose: "personal",
        supplier_name: "Shop",
        evidence: [await f.cite("t-lease", "lease")],
      },
    ],
  }
  expect(() => parseMailFindingsJson(JSON.stringify(order))).toThrow(
    expect.objectContaining({
      message: "missing mail finding field reason in o1 (order); it needs purpose, supplier_name, reason",
      details: expect.objectContaining({ reason: "finding.missing-field", fields: ["reason"], kind: "order" }),
    }),
  )
  const cited = await f.cite("t-lease", "lease")
  const task = (due: Record<string, unknown>) =>
    JSON.stringify({
      ...order,
      findings: [
        {
          id: "t1",
          kind: "task",
          type: "chore",
          title: "Sign",
          reason: "asked",
          commitment: "explicit",
          ...due,
          evidence: [cited],
        },
      ],
    })
  expect(() => parseMailFindingsJson(task({ due_at: "2026-11-09", due_evidence: [cited.reference] }))).toThrow(
    /due_at must be an ISO timestamp with a timezone, such as 2026-11-09T09:00:00Z/,
  )
  expect(() => parseMailFindingsJson(task({ due_at: "2026-11-09T09:00:00Z" }))).toThrow(
    /due_at comes with due_evidence/,
  )
  expect(() => parseMailFindingsJson(task({ due_at: "2026-11-09T09:00:00Z", due_evidence: [cited] }))).toThrow(
    /due_evidence lists 1–8 references .*not evidence objects/,
  )
  expect(
    parseMailFindingsJson(task({ due_at: "2026-11-09T09:00:00Z", due_evidence: [cited.reference] })).findings[0],
  ).toMatchObject({ dueAt: "2026-11-09T09:00:00.000Z" })
  const help = mailFindingFieldsHelp()
  expect(help).toContain("  order: purpose personal|business|client|other, supplier_name, reason; optional customer,")
  expect(help.split("\n").map((line) => line.trim().split(":")[0])).toEqual(Object.keys(MAIL_FINDING_FIELDS))
})

it("checks a whole batch without staging it, naming every finding's problem", async () => {
  const f = await fixture()
  const cited = [await f.cite("t-lease", "lease")]
  const input = readMailFindingsJson(
    JSON.stringify({
      schema_version: 1,
      key: "mail-triage:41",
      extractor: "synthetic",
      findings: [
        { id: "f1", kind: "fact", type: "fact", statement: "Certificate 12-345", expires: "x", evidence: cited },
        {
          id: "i1",
          kind: "invoice",
          direction: "payable",
          currency: "EUR",
          lines: [{ description: "Desk", amount: "1" }],
          reason: "r",
          evidence: cited,
        },
        {
          id: "t1",
          kind: "task",
          type: "chore",
          title: "Sign",
          reason: "asked",
          commitment: "explicit",
          evidence: cited,
        },
      ],
    }),
  )
  const checked = await f.store.mailFindings.check(MINE, input, agent)
  expect(checked).toMatchObject({ valid: false, findings: 3, batch: null })
  expect(checked.problems.map((one) => [one.finding, one.kind, one.details?.reason ?? null])).toEqual([
    ["f1", "fact", "finding.unknown-field"],
    ["i1", "invoice", null],
  ])
  expect(checked.problems[1]?.message).toMatch(/counterparty_name/)

  const fixed = { ...input, findings: input.findings.filter((one) => one.id === "t1") }
  expect(await f.store.mailFindings.check(MINE, fixed, agent)).toEqual({
    valid: true,
    findings: 1,
    batch: null,
    problems: [],
  })
  expect((await f.store.mailFindings.list()).items).toEqual([])
  const staged = await f.store.mailFindings.stage(MINE, fixed, agent)
  expect(await f.store.mailFindings.check(MINE, fixed, agent)).toMatchObject({ valid: true, batch: staged.id })
  expect((await f.store.mailFindings.check(MINE, input, agent)).problems).toContainEqual(
    expect.objectContaining({ finding: null, details: { reason: "mail-findings.key-used" } }),
  )
})

it("records an invoice to a counterparty named only in the mail, finding its organization or making one", async () => {
  const f = await fixture()
  const cited = [await f.cite("t-lease", "lease")]
  const invoice = (id: string, key: string, party: Record<string, string>) =>
    f.batch(
      [
        {
          id,
          kind: "invoice",
          direction: "payable",
          ...party,
          currency: "EUR",
          lines: [{ description: "Accounting", amount: "49.00" }],
          reason: "the monthly bill",
          evidence: cited,
        } as MailFinding,
      ],
      key,
    )
  const accept = async (batch: Awaited<ReturnType<typeof f.store.mailFindings.stage>>) => {
    const reviewed = await f.store.mailFindings.review(batch.id, {
      fingerprint: batch.fingerprint,
      accept: batch.input.findings.map((one) => one.id),
      by: "owner",
    })
    return f.store.finance.invoice(reviewed.receipt?.items[0]?.reference as string)
  }
  const stranger = await invoice("i0", "mail-triage:50", {
    counterpartyName: "Lab",
    counterpartyEmail: "x@else.example",
  })
  expect((await f.store.mailFindings.check(MINE, stranger, agent)).problems[0]?.message).toMatch(
    /neither sent nor received/,
  )

  const named = await invoice("i1", "mail-triage:51", {
    counterpartyName: "Ann Lab GmbH",
    counterpartyEmail: "ann@example.com",
  })
  expect((await f.store.mailFindings.check(MINE, named, agent)).valid).toBe(true)
  const first = await accept(await f.store.mailFindings.stage(MINE, named, agent))
  expect(await f.store.knowledge.organizations()).toEqual([
    expect.objectContaining({ name: "Ann Lab GmbH", kind: "company" }),
  ])
  expect(first.counterparty).toMatchObject({ ref: (await f.store.knowledge.organizations())[0]?.ref })

  const again = await accept(
    await f.store.mailFindings.stage(
      MINE,
      await invoice("i2", "mail-triage:52", { counterpartyName: "ann lab gmbh" }),
      agent,
    ),
  )
  expect(again.counterparty).toEqual(first.counterparty)
  expect(await f.store.knowledge.organizations()).toHaveLength(1)
  const byAddress = await accept(
    await f.store.mailFindings.stage(
      MINE,
      await invoice("i3", "mail-triage:53", { counterpartyName: "Ann Lab", counterpartyEmail: "ann@example.com" }),
      agent,
    ),
  )
  expect(byAddress.counterparty).toEqual(first.counterparty)
})

it("refuses an order that already waits for the owner in another findings batch", async () => {
  const f = await fixture()
  const order = async (key: string, cited: readonly [string, string]) =>
    f.batch(
      [
        {
          id: "o1",
          kind: "order",
          purpose: "personal",
          supplierName: "Shop One",
          number: "A-1",
          reason: "the order is placed",
          evidence: [await f.cite(...cited)],
        },
      ],
      key,
    )
  await f.store.mailFindings.stage(MINE, await order("mail-triage:60", ["t-lease", "lease"]), agent)
  await expect(
    f.store.mailFindings.stage(MINE, await order("mail-triage:61", ["t-0", "ask-0"]), agent),
  ).rejects.toMatchObject({
    details: { reason: "order.proposed" },
  })
})

it("takes a new contact only when the mail's text gives a better name than the sender line", async () => {
  const f = await fixture()
  const lease = [await f.cite("t-lease", "lease")]
  const contact = (name: string): MailFinding => ({
    id: "c1",
    kind: "new_contact",
    address: "ann@example.com",
    name,
    reason: "she signs with it",
    evidence: lease,
  })
  const stage = async (name: string, key: string) =>
    f.store.mailFindings.stage(MINE, await f.batch([contact(name)], key), agent)

  await expect(stage("Ann", "mail-triage:11")).rejects.toMatchObject({ details: { reason: "new-contact.sender-line" } })
  await expect(stage("ANN", "mail-triage:12")).rejects.toMatchObject({ details: { reason: "new-contact.sender-line" } })
  await expect(stage("Ann Invented", "mail-triage:13")).rejects.toMatchObject({
    details: { reason: "new-contact.not-in-text" },
  })
  expect(
    await f.store.mailFindings.check(MINE, await f.batch([contact("Ann")], "mail-triage:14"), agent),
  ).toMatchObject({
    valid: false,
    problems: [{ finding: "c1", kind: "new_contact" }],
  })
  expect((await f.store.mailFindings.list({ account: MINE, status: "proposed" })).items).toEqual([])

  const staged = await stage("Ann Lessor", "mail-triage:15")
  const registry = proposalRegistry(f.store)
  expect((await registry.list({ kinds: ["mail_findings"], limit: 10, offset: 0 })).items).toMatchObject([
    { id: staged.id, parts: [{ id: "c1", kind: "new_contact" }] },
  ])
  await registry.decide([staged.id], { confirm: true, by: "owner" })
  expect((await f.store.people.personOf({ provider: "email", id: "ann@example.com" }))?.name).toBe("Ann Lessor")
})
