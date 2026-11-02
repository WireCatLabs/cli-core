import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseEvidenceFindingsJson } from "../cli/meeting-findings-input.js"
import { projectStatusText } from "../cli/project-status.js"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import { projectStatus } from "../services/project-status/index.js"
import { proposalRegistry } from "../services/proposals/index.js"
import { rollBackTo } from "../testing/older-store.js"
import { harbourStore, NOW } from "../testing/project-status.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the transfer message says so" }
const ASK = "msg:max/11/-900/3"
const REMINDER = "msg:max/11/-900/5"

const fixture = async () => {
  const { store, project } = await harbourStore(undefined, { agentDecisions: true, ruleProposalsOwnerOnly: true })
  opened.push(store)
  const ana = await store.knowledge.addOrganization({ kind: "company", name: "Ana Studio" })
  const expected = { amount: "1200", currency: "EUR", direction: "to_us", counterparty: ana.ref, state: "expected" }
  const stage = async (key: string, findings: Record<string, unknown>[]) => {
    const records = store.contextRecords
    if (!records) throw new Error("no record reader")
    const evidence = await Promise.all(
      [ASK, REMINDER].map(async (reference) => {
        const record = await records.read(reference)
        if (!record) throw new Error(`no ${reference}`)
        return { reference, fingerprint: contextEvidenceFingerprint(record) }
      }),
    )
    const json = JSON.stringify({
      schema_version: 1,
      key,
      extractor: "synthetic",
      findings: findings.map((one, at) => ({ id: `f${at}`, kind: "payment", project, evidence, ...one })),
    })
    return store.evidenceFindings.stage(parseEvidenceFindingsJson(json), claude)
  }
  const confirm = async (batch: { id: string }) => {
    const { decided } = await proposalRegistry(store).decide([batch.id], { confirm: true, by: "owner" })
    return decided[0]?.made ?? []
  }
  return { store, project, ana, expected, stage, confirm }
}

describe("payment findings", () => {
  it("become a confirmed payments row when the owner confirms, and no fact", async () => {
    const f = await fixture()
    const batch = await f.stage("paid", [
      { payment: { ...f.expected, state: "paid", paid_at: "2026-10-30", item: "September" } },
    ])
    const registry = proposalRegistry(f.store)
    expect((await registry.decide([batch.id], { confirm: true, by: codex })).refused).toMatchObject([
      { reason: "proposal.owner-only" },
    ])

    const [made] = await f.confirm(batch)
    expect(made).toMatch(/^payment:\d+$/)
    expect(await f.store.finance.payment(made ?? "")).toMatchObject({
      review: "confirmed",
      direction: "in",
      payer: { ref: f.ana.ref, name: "Ana Studio" },
      amount: "1200.00",
      currency: "EUR",
      date: "2026-10-30",
      reference: "September",
      project: f.project,
      author: { type: "bot", name: "claude-code" },
      confirmedBy: { type: "person" },
      reason: "1 200 EUR to us from organization:1 for September (paid)",
      evidence: [ASK, REMINDER],
    })
    expect(await f.store.facts.list({})).toEqual([])
  })

  it("make an expected one an invoice that a paid one settles, and a cancelled one void another", async () => {
    const f = await fixture()
    const [owed, dropped] = await f.confirm(
      await f.stage("owed", [
        { payment: { ...f.expected, due_at: "2026-10-31", item: "September" } },
        { payment: { ...f.expected, amount: "300" } },
      ]),
    )
    expect(await f.store.finance.invoice(owed ?? "")).toMatchObject({
      direction: "receivable",
      review: "confirmed",
      total: "1200.00",
      dueDate: "2026-10-31",
      status: "issued",
      lines: [{ description: "September", amount: "1200.00" }],
    })

    const [paid, voided] = await f.confirm(
      await f.stage("settled", [
        { payment: { ...f.expected, amount: "1500", state: "paid" }, supersedes: owed },
        { payment: { ...f.expected, amount: "300", state: "cancelled" }, supersedes: dropped },
      ]),
    )
    expect(await f.store.finance.invoice(owed ?? "")).toMatchObject({ status: "paid", open: "0.00" })
    expect((await f.store.finance.payment(paid ?? "")).allocations).toMatchObject([
      { invoice: owed, amount: "1200.00" },
    ])
    expect(voided).toBe(dropped)
    expect((await f.store.finance.invoice(dropped ?? "")).status).toBe("void")
  })

  it("are refused when they cannot be money rows", async () => {
    const f = await fixture()
    await expect(f.stage("a", [{ payment: f.expected, supersedes: "fact:1" }])).rejects.toThrow("invoice:")
    await expect(
      f.stage("b", [{ payment: { ...f.expected, counterparty: null, counterparty_name: "Ana" } }]),
    ).rejects.toThrow("person: or organization:")
    await expect(f.stage("c", [{ payment: { ...f.expected, state: "cancelled" } }])).rejects.toThrow("supersedes")
    await expect(f.stage("d", [{ payment: { ...f.expected, currency: "JPY", amount: "10.50" } }])).rejects.toThrow(
      "JPY",
    )
    expect(() =>
      parseEvidenceFindingsJson(
        JSON.stringify({
          schema_version: 1,
          key: "k",
          extractor: "synthetic",
          findings: [
            {
              id: "x",
              kind: "fact",
              type: "payment",
              statement: "Paid",
              project: f.project,
              evidence: [{ reference: ASK, fingerprint: "a".repeat(64) }],
            },
          ],
        }),
      ),
    ).toThrow("a finding of kind payment")
  })
})

describe("payment facts", () => {
  it("are refused, naming the payments table", async () => {
    const f = await fixture()
    await expect(
      f.store.facts.add({ type: "payment" as never, statement: "Ana paid", evidence: [ASK], by: "owner" }),
    ).rejects.toMatchObject({ details: { reason: "fact.payment-retired" }, message: /store\.finance\.addPayment/ })
  })

  it("move into finance rows when a version 45 file opens", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "version-46-")), "wirecat.db")
    const store = await openStore({ path })
    const ana = await store.knowledge.addOrganization({ kind: "company", name: "Ana Studio" })
    const project = await store.knowledge.addProject({ name: "Harbour site", key: "HRB" })
    const fact = (statement: string) => store.facts.add({ type: "fact", statement, project: project.ref, by: claude })
    const owed = await fact("Ana owes September")
    const paid = await fact("Ana paid September")
    const vague = await fact("Someone owes something")
    await store.facts.accept(owed.ref, "owner")
    await store.close()

    const old = await openCache(path)
    rollBackTo(old, 46)
    const payment = (id: string, fields: Record<string, unknown>, supersedes: string | null = null) =>
      old
        .prepare("UPDATE facts SET type = 'payment', metadata = ?, supersedes_id = ? WHERE id = ?")
        .run(
          JSON.stringify({ payment: { amount: "1200.00", currency: "EUR", direction: "to_us", ...fields } }),
          supersedes,
          Number(id),
        )
    payment(owed.id, { counterparty: ana.ref, state: "expected", due_at: "2026-10-31" })
    payment(paid.id, { counterparty: ana.ref, state: "paid", due_at: "2026-10-31" }, owed.id)
    payment(vague.id, { counterparty_name: "Someone", state: "expected" })
    old.close()

    const upgraded = await openStore({ path })
    opened.push(upgraded)
    const [invoice] = await upgraded.finance.invoices({})
    expect(invoice).toMatchObject({ review: "confirmed", total: "1200.00", project: project.ref, status: "issued" })
    const [moved] = await upgraded.finance.payments({})
    expect(moved).toMatchObject({
      review: "proposed",
      amount: "1200.00",
      date: "2026-10-31",
      author: { name: "claude-code" },
    })
    expect((await upgraded.finance.payment(moved?.ref ?? "")).allocations).toMatchObject([{ invoice: invoice?.ref }])
    await upgraded.finance.confirm(moved?.ref ?? "", "owner")
    expect((await upgraded.finance.invoice(invoice?.ref ?? "")).status).toBe("paid")
    expect((await upgraded.facts.list({})).map((one) => [one.ref, one.type])).toEqual([[vague.ref, "statement"]])
  })
})

describe("project status payments", () => {
  it("lists payments and open invoices by their refs and totals only confirmed invoices", async () => {
    const f = await fixture()
    const before = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    expect(before.money.open).toContainEqual({ direction: "to_us", currency: "EUR", amount: "1200.00", rows: 1 })

    const [owed] = await f.confirm(await f.stage("owed", [{ payment: f.expected }]))
    const found = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    expect(found.money.open.filter((one) => one.direction === "to_us")).toEqual([
      { direction: "to_us", currency: "EUR", amount: "1200.00", rows: 1 },
    ])

    const [paid] = await f.confirm(
      await f.stage("paid", [{ payment: { ...f.expected, state: "paid", paid_at: "2026-10-30" }, supersedes: owed }]),
    )
    const after = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    const rows = after.items.filter((one) => one.signal === "payments")
    expect(rows.map((one) => [one.evidence[0]?.ref, (one.data as { state: string }).state])).toEqual([[paid, "paid"]])
    expect(rows[0]?.data).toMatchObject({ status: "confirmed", amount: "1200.00", counterparty_name: "Ana Studio" })
    const line = (step: { why?: string }) => step.why ?? ""
    expect(projectStatusText(after, { sync: () => ({}) as never, read: () => ({}) as never, line })).toContain(
      `  payment Payment · 1 200.00 EUR from Ana Studio, 30.10 · ${paid} [confirmed]`,
    )
  })
})
