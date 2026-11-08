import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { refLabel } from "../domain/ref-summaries.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const claude = { bot: "claude-code", model: "synthetic" }

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "transactions-")), "store.db")
  let clock = Date.UTC(2026, 10, 20)
  const store = await openStore({ path, now: () => clock++ })
  handles.push(store)
  const wallet = await store.wallets.add({
    by: "owner",
    name: "Тинькофф",
    currency: "RUB",
    institution: "Т-Банк",
    numberHint: "1234",
    openingBalance: "1000.00",
    openingDate: "2026-10-31",
  })
  const add = (amount: string, extra: Record<string, unknown> = {}) =>
    store.transactions.add({
      by: "owner",
      wallet: wallet.ref,
      direction: "in",
      amount,
      statementDate: "2026-11-05",
      ...extra,
    })
  return { store, path, wallet, add }
}

const reasonOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { details?: { reason?: string } }) => error.details?.reason,
  )

it("computes a wallet's balance from its opening and its confirmed, booked transactions, pending ones beside it", async () => {
  const f = await fixture()
  await f.add("500.00")
  await f.add("200.00", { direction: "out", statementDate: "2026-11-06" })
  await f.add("50.00", { status: "pending", statementDate: "2026-11-07" })
  await f.add("900.00", { statementDate: "2026-10-30" })
  await f.store.transactions.add({
    by: claude,
    wallet: f.wallet.ref,
    direction: "in",
    amount: "70.00",
    statementDate: "2026-11-08",
  })

  expect(await f.store.wallets.get(f.wallet.ref)).toMatchObject({
    openingBalance: "1000.00",
    balance: { amount: "1300.00", currency: "RUB" },
    pending: { amount: "120.00", currency: "RUB" },
    title: "Тинькофф · bank, RUB, …1234",
  })
  expect((await f.store.wallets.get(f.wallet.ref, { until: "2026-11-05" })).balance.amount).toBe("1500.00")
  const summary = (await f.store.refs.summaries([f.wallet.ref])).get(f.wallet.ref)
  expect(refLabel(summary as NonNullable<typeof summary>)).toBe("Wallet «Тинькофф · bank, RUB, …1234»")
})

it("keeps the opening balance and a whole card number from anyone but the owner, and from any one", async () => {
  const f = await fixture()
  expect(
    await reasonOf(
      f.store.wallets.update(f.wallet.ref, { by: claude, openingBalance: "0.00", openingDate: "2026-11-01" }),
    ),
  ).toBe("finance.owner-only")
  expect(
    await reasonOf(
      f.store.wallets.add({ by: "owner", name: "Карта", currency: "RUB", numberHint: "4276 1234 5678 9012" }),
    ),
  ).toBe("wallet.number")
  const cash = await f.store.wallets.add({ by: claude, name: "Касса", currency: "EUR", kind: "cash" })
  expect(cash).toMatchObject({ kind: "cash", openingBalance: null, balance: { amount: "0.00", currency: "EUR" } })
  expect(
    await f.store.wallets.update(cash.ref, { by: "owner", openingBalance: "-12.50", openingDate: "2026-11-01" }),
  ).toMatchObject({
    openingBalance: "-12.50",
    balance: { amount: "-12.50" },
  })
})

it("links a payment only of the same currency, direction and amount, and only to one transaction", async () => {
  const f = await fixture()
  const payment = await f.store.finance.addPayment({
    by: "owner",
    direction: "in",
    amount: "500.00",
    currency: "RUB",
    date: "2026-11-05",
  })
  expect(await reasonOf(f.add("499.99", { payment: payment.ref }))).toBe("transaction.payment")
  expect(await reasonOf(f.add("500.00", { direction: "out", payment: payment.ref }))).toBe("transaction.payment")
  const linked = await f.add("500.00", { payment: payment.ref })
  expect(linked.payment).toBe(payment.ref)
  expect(await reasonOf(f.add("500.00", { payment: payment.ref }))).toBe("transaction.payment")
  const fee = await f.add("15.00", { direction: "out", description: "Комиссия банка" })
  expect(await reasonOf(f.store.transactions.update(fee.ref, { by: "owner", payment: payment.ref }))).toBe(
    "transaction.payment",
  )
  expect(await reasonOf(f.add("10.00", { currency: "EUR" }))).toBe("money.currency")
})

it("splits a transaction by category within its amount and totals the categories per currency", async () => {
  const f = await fixture()
  const groceries = await f.add("1000.00", {
    direction: "out",
    counterpartyName: "Пятёрочка",
    splits: [
      { amount: "600.00", category: "Продукты" },
      { amount: "150.00", category: "Хозяйство" },
    ],
  })
  expect(groceries).toMatchObject({
    uncategorized: "250.00",
    title: "Transaction · 1 000.00 RUB out · Пятёрочка, 05.11",
  })
  expect(
    await reasonOf(f.store.transactions.addSplit(groceries.ref, { by: "owner", amount: "250.01", category: "Прочее" })),
  ).toBe("transaction.split")
  await f.store.transactions.addSplit(groceries.ref, { by: "owner", amount: "100.00", category: "продукты" })
  expect(await f.store.transactions.categories()).toEqual([
    { category: "Продукты", amount: "700.00", currency: "RUB" },
    { category: "Хозяйство", amount: "150.00", currency: "RUB" },
    { category: null, amount: "150.00", currency: "RUB" },
  ])
  expect((await f.store.transactions.list({ category: "ПРОДУКТЫ" })).map((one) => one.ref)).toEqual([groceries.ref])
  expect((await f.store.transactions.list({ uncategorized: true })).map((one) => one.ref)).toEqual([groceries.ref])
})

it("lets an agent change only its own proposed transaction, and only the owner decide it", async () => {
  const f = await fixture()
  const proposed = await f.store.transactions.add({
    by: claude,
    wallet: f.wallet.ref,
    direction: "out",
    amount: "99.00",
    statementDate: "2026-11-09",
    status: "pending",
  })
  expect(proposed.review).toBe("proposed")
  await f.store.transactions.addSplit(proposed.ref, { by: claude, amount: "99.00", category: "Связь" })
  const owners = await f.add("10.00")
  expect(await reasonOf(f.store.transactions.addSplit(owners.ref, { by: claude, amount: "1.00", category: "x" }))).toBe(
    "finance.owner-only",
  )
  expect(
    await reasonOf(f.store.transactions.confirm(proposed.ref, { bot: "codex", reason: "the statement shows it" })),
  ).toBe("proposal.owner-only")
  await f.store.transactions.update(proposed.ref, { by: claude, status: "booked", bookedDate: "2026-11-10" })
  expect(await f.store.transactions.confirm(proposed.ref, "owner")).toMatchObject({
    review: "confirmed",
    status: "booked",
  })
  expect((await f.store.wallets.get(f.wallet.ref)).balance.amount).toBe("911.00")
})

it("keeps a stray write to the bank tables within the same rules", async () => {
  const f = await fixture()
  const payment = await f.store.finance.addPayment({
    by: "owner",
    direction: "in",
    amount: "500.00",
    currency: "RUB",
    date: "2026-11-05",
  })
  const one = await f.add("500.00", { splits: [{ amount: "400.00", category: "Аренда" }] })
  const database = await openCache(f.path)
  handles.push(database)
  const insert = (currency: string, status: string, booked: string | null, paymentId: number | null) =>
    database
      .prepare(
        "INSERT INTO financial_transactions (financial_account_id, direction, amount, currency, status, statement_date, " +
          "booked_date, payment_id, review, author_type, author_id, source, created_at, updated_at) " +
          "VALUES (?, 'in', 50000, ?, ?, '2026-11-05', ?, ?, 'confirmed', 'person', 1, 'owner', 1, 1)",
      )
      .run(Number(f.wallet.id), currency, status, booked, paymentId)
  expect(() => insert("EUR", "booked", "2026-11-05", null)).toThrow(/financial_transactions/)
  expect(() => insert("RUB", "booked", null, null)).toThrow(/financial_transactions/)
  expect(() => insert("RUB", "pending", "2026-11-05", null)).toThrow(/financial_transactions/)
  database.prepare("UPDATE payments SET amount = 49999 WHERE id = ?").run(Number(payment.id))
  expect(() => insert("RUB", "booked", "2026-11-05", Number(payment.id))).toThrow(/its payment of the same amount/)
  expect(() =>
    database
      .prepare(
        "INSERT INTO transaction_splits (transaction_id, position, category, category_folded, amount, created_at, updated_at) " +
          "VALUES (?, 9, 'x', 'x', 10001, 1, 1)",
      )
      .run(Number(one.id)),
  ).toThrow(/within the transaction/)
  expect(() =>
    database.prepare("UPDATE financial_transactions SET amount = 39999 WHERE id = ?").run(Number(one.id)),
  ).toThrow(/at or above its splits/)
  expect(() =>
    database.prepare("UPDATE financial_accounts SET currency = 'EUR' WHERE id = ?").run(Number(f.wallet.id)),
  ).toThrow(/the currency kept/)
  expect(() =>
    database.prepare("UPDATE financial_accounts SET number_hint = '12345' WHERE id = ?").run(Number(f.wallet.id)),
  ).toThrow(/financial_accounts/)
})
