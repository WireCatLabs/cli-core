import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { parseMailFindingsJson } from "../cli/findings-input.js"
import { formatLocator } from "../domain/locator.js"
import type { MailFinding, MailFindingsInput } from "../mail/findings.js"
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
  await save("t-lease", email("lease"), email("reply", { from: { address: MINE.account, name: "Me" }, outgoing: true }))
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
        { id: "f1", kind: "fact", type: "decision", statement: "The lease starts in May", evidence: lease },
        {
          id: "m1",
          kind: "memory",
          memoryKind: "summary",
          scope: "personal",
          body: "Ann rents the flat",
          project: f.project.ref,
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
        { id: "c1", kind: "new_contact", address: "ann@example.com", name: "Ann Lessor", evidence: lease },
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
