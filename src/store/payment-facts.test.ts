import { afterEach, describe, expect, it } from "vitest"
import { parseEvidenceFindingsJson } from "../cli/meeting-findings-input.js"
import { paymentFilterOf } from "../cli/payment-query.js"
import { contextEvidenceFingerprint } from "../context/evidence.js"
import { projectStatus } from "../services/project-status/index.js"
import { proposalRegistry } from "../services/proposals/index.js"
import { harbourStore, NOW } from "../testing/project-status.js"
import type { MessageStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const claude = { bot: "claude-code", model: "synthetic" }
const codex = { bot: "codex", reason: "the transfer message says so" }
const ASK = "msg:max/11/-900/3"
const REMINDER = "msg:max/11/-900/5"
const LEV_ASK = "msg:telegram/22/555/12"
const expected = { amount: "1200", currency: "EUR", direction: "to_us", counterparty_name: "Ana", state: "expected" }

const fixture = async () => {
  const { store, project } = await harbourStore()
  opened.push(store)
  const pay = (payment: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    store.facts.add({
      type: "payment",
      statement: "Ana's company owes the September invoice",
      project,
      evidence: [ASK],
      by: claude,
      payment: payment as never,
      ...more,
    })
  return { store, project, pay }
}

describe("payment facts", () => {
  it("keeps the payment in the fact, the owner's accepted at once and an agent's proposed", async () => {
    const f = await fixture()
    const owner = await f.pay({ ...expected, due_at: "2026-10-31" }, { by: "owner" })
    expect(owner).toMatchObject({
      type: "payment",
      status: "accepted",
      evidence: [ASK],
      payment: { amount: "1200.00", currency: "EUR", direction: "to_us", due_at: "2026-10-31", state: "expected" },
    })
    expect((await f.store.facts.get(owner.ref)).payment?.amount).toBe("1200.00")
    expect((await f.pay(expected)).status).toBe("proposed")
    const fact = await f.store.facts.add({ type: "fact", statement: "Kickoff moved", by: "owner" })
    expect(fact.payment).toBeNull()
  })

  it("refuses a payment fact without its payment or evidence, and a payment on another type", async () => {
    const f = await fixture()
    await expect(f.pay(undefined as never)).rejects.toThrow("needs its payment")
    await expect(f.pay(expected, { evidence: [] })).rejects.toThrow("cites 1–8 references")
    await expect(f.pay({ ...expected, amount: "12.345" })).rejects.toThrow("at most 2 decimals")
    await expect(f.pay({ ...expected, counterparty: "person:999" })).rejects.toThrow()
    await expect(f.pay(expected, { type: "fact" })).rejects.toThrow("only a payment fact takes a payment")
    const decision = await f.store.facts.add({ type: "decision", statement: "Invoice monthly", by: "owner" })
    await expect(f.pay(expected, { supersedes: decision.ref })).rejects.toThrow("corrects a payment fact")
  })

  it("lets only the owner accept or reject a payment", async () => {
    const f = await fixture()
    const proposed = await f.pay(expected)
    await expect(f.store.facts.accept(proposed.ref, codex)).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "proposal.owner-only" },
    })
    await expect(f.store.facts.reject(proposed.ref, codex)).rejects.toMatchObject({ code: "permission_error" })
    const registry = proposalRegistry(f.store)
    expect((await registry.decide([proposed.ref], { confirm: true, by: codex })).refused).toMatchObject([
      { id: proposed.ref, reason: "proposal.owner-only" },
    ])
    expect((await f.store.facts.reject(proposed.ref, "owner")).status).toBe("rejected")
  })

  it("supersedes the expected payment by the paid one, and lists open payments by direction", async () => {
    const f = await fixture()
    const owed = await f.pay(expected, { by: "owner" })
    const contractor = await f.pay(
      { amount: "300", currency: "EUR", direction: "from_us", counterparty_name: "Lev", state: "expected" },
      { by: "owner", evidence: [LEV_ASK] },
    )
    const paid = await f.pay({ ...expected, state: "paid" }, { supersedes: owed.ref, evidence: [ASK, REMINDER] })
    const open = (terms: Record<string, string>) =>
      f.store.facts.list({ payment: paymentFilterOf(new Map(Object.entries(terms))) as never })

    expect((await open({ open: "true" })).map((one) => one.ref)).toEqual([contractor.ref, owed.ref])
    await f.store.facts.accept(paid.ref, "owner")
    expect((await f.store.facts.get(owed.ref)).status).toBe("superseded")
    expect((await open({ open: "true" })).map((one) => one.ref)).toEqual([contractor.ref])
    expect(await open({ open: "true", direction: "to_us" })).toEqual([])
    expect((await open({ state: "paid" })).map((one) => one.ref)).toEqual([paid.ref])
    expect((await open({ open: "false" })).map((one) => one.ref).sort()).toEqual([owed.ref, paid.ref].sort())
    expect(await f.store.facts.list({ type: "decision" })).toEqual([])
    expect(paymentFilterOf(new Map([["kind", "payment"]]))).toBeUndefined()
    expect(() => paymentFilterOf(new Map([["open", "yes"]]))).toThrow("true or false")
  })
})

describe("payment findings", () => {
  const stage = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const records = f.store.contextRecords
    if (!records) throw new Error("no record reader")
    const record = await records.read(ASK)
    if (!record) throw new Error(`no ${ASK}`)
    const json = JSON.stringify({
      schema_version: 1,
      key: "harbour-money",
      extractor: "synthetic",
      findings: [
        {
          id: "invoice",
          kind: "payment",
          project: f.project,
          payment: { ...expected, due_at: "2026-10-31", item: "September" },
          evidence: [{ reference: ASK, fingerprint: contextEvidenceFingerprint(record) }],
        },
      ],
    })
    return f.store.evidenceFindings.stage(parseEvidenceFindingsJson(json), claude)
  }

  it("confirms into an accepted payment fact, decided by the owner only", async () => {
    const f = await fixture()
    const batch = await stage(f)
    const registry = proposalRegistry(f.store)
    expect((await registry.get(batch.id)).parts).toEqual([
      {
        id: "invoice",
        kind: "payment",
        summary: "1 200 EUR to us from Ana for September, due 31.10 (expected)",
        outcome: null,
      },
    ])
    expect((await registry.decide([batch.id], { confirm: true, by: codex })).refused).toMatchObject([
      { reason: "proposal.owner-only" },
    ])
    const { decided } = await registry.decide([batch.id], { confirm: true, by: "owner" })
    const made = decided[0]?.made[0] ?? ""
    expect(await f.store.facts.get(made)).toMatchObject({
      type: "payment",
      status: "accepted",
      statement: "1 200 EUR to us from Ana for September, due 31.10 (expected)",
      evidence: [ASK],
      payment: { amount: "1200.00", due_at: "2026-10-31", item: "September" },
    })
  })

  it("refuses a payment finding with a bad payment, and a fact finding typed payment", async () => {
    const f = await fixture()
    const finding = { id: "x", project: f.project, evidence: [{ reference: ASK, fingerprint: "a".repeat(64) }] }
    const input = (one: Record<string, unknown>) =>
      JSON.stringify({ schema_version: 1, key: "k", extractor: "synthetic", findings: [{ ...finding, ...one }] })
    expect(() => parseEvidenceFindingsJson(input({ kind: "payment", payment: { ...expected, amount: "-1" } }))).toThrow(
      "amount",
    )
    expect(() => parseEvidenceFindingsJson(input({ kind: "fact", type: "payment", statement: "Paid" }))).toThrow(
      "a finding of kind payment",
    )
    expect(() =>
      parseEvidenceFindingsJson(input({ kind: "payment", payment: expected, supersedes: "task:1" })),
    ).toThrow("supersedes a fact:")
  })
})

describe("project status payments", () => {
  it("totals expected payment facts per direction and currency, once with the ask they cite", async () => {
    const f = await fixture()
    const before = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    expect(before.money.open).toContainEqual({ direction: "to_us", currency: "EUR", amount: "1200.00", rows: 1 })

    const owed = await f.pay(expected, { by: "owner" })
    await f.pay(
      { amount: "450.5", currency: "EUR", direction: "from_us", counterparty_name: "Lev", state: "expected" },
      { by: "owner", evidence: ["msg:telegram/22/555/10"] },
    )
    const found = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    const totals = Object.fromEntries(found.money.open.map((one) => [`${one.direction} ${one.currency}`, one]))
    expect(totals["to_us EUR"]).toMatchObject({ amount: "1200.00", rows: 1 })
    expect(totals["from_us EUR"]).toMatchObject({ amount: "750.50", rows: 2 })
    expect(found.items.filter((one) => one.signal === "payments").map((one) => one.data)).toContainEqual(
      expect.objectContaining({ title: "1 200 EUR to us from Ana (expected)", status: "accepted", state: "expected" }),
    )

    await f.pay({ ...expected, state: "paid" }, { by: "owner", supersedes: owed.ref })
    const after = await projectStatus(f.store, { project: "HRB", asOf: NOW })
    const payments = after.items.filter((one) => one.signal === "payments")
    expect(payments.map((one) => (one.data as { state: string }).state).sort()).toEqual(["expected", "paid"])
    expect(after.money.open.find((one) => one.direction === "to_us")).toBeUndefined()
  })
})
