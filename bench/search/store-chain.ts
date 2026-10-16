// The phase 2 search through the real store, on a file `store.ts build N` made: each step of the chain
// timed through `openStore` against the acceptance of plan §6, typo correction's recall and precision,
// the scope token against the join for chats of growing size (plan S6), and the fill from nothing.
// Needs the package built: `pnpm build` at the repository root.
//
//   node store-chain.ts N            search, correction, the token/join crossover
//   node store-chain.ts N crossover  the token/join crossover alone
//   node store-chain.ts N fill       drop the word index and fill it again (writes the file)
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR, FUZZY, filters, fmt, loadMeta, out, pctl, RUNTIME } from "./common.ts"

const dist = join(import.meta.dirname, "../../dist")
const { openStore } = await import(join(dist, "store/index.js"))
const { search } = await import(join(dist, "search/search.js"))
const { correctWords } = await import(join(dist, "search/correct.js"))
const { openSqlite } = await import(join(dist, "store/sqlite/open.js"))
const { fillSearchIndex, resetSearchIndex } = await import(join(dist, "store/sqlite/search-index.js"))
const { SCOPE_TOKEN_LIMIT } = await import(join(dist, "store/sqlite/words.js"))

const [nArg, phase = "search"] = process.argv.slice(2)
const N = Number(nArg)
const file = join(DATA_DIR, `store-${N}-node`, "messages.db")
if (!Number.isInteger(N) || !existsSync(file)) throw new Error("usage: node store-chain.ts N [fill], after `node store.ts build N`")
const { meta, truth } = loadMeta(N)
const LIMIT = 20
const ROUNDS = 40

const SOURCES = ["max", "telegram", "whatsapp"]
const sourceOf = (chat: number) => SOURCES[chat === 0 ? 0 : chat % 3] as string
const accounts = SOURCES.map((provider) => ({ provider, account: "bench" }))
const chatScope = (chat: number) => ({ account: { provider: sourceOf(chat), account: "bench" }, chatId: String(chat) })
const words = (list: string[]) => ({ required: list.map((text) => [{ kind: "word", text }]), excluded: [] })

const timed = async (run: (i: number) => unknown) => {
  const took: number[] = []
  for (let i = -3; i < ROUNDS; i++) {
    const t = performance.now()
    await run(Math.abs(i))
    if (i >= 0) took.push(performance.now() - t)
  }
  return took
}
/** Two forms of one query, taking turns at going first, so neither gets the other's warm cache. */
const inTurns = async (a: (i: number) => unknown, b: (i: number) => unknown) => {
  const took: [number[], number[]] = [[], []]
  for (let i = -3; i < ROUNDS; i++) {
    for (const which of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const t = performance.now()
      await (which === 0 ? a : b)(Math.abs(i))
      if (i >= 0) took[which]?.push(performance.now() - t)
    }
  }
  return took
}
const row = (label: string, took: number[], target = "") =>
  out(`| ${label} | ${fmt(pctl(took, 50))} | ${fmt(pctl(took, 95))} | ${target} |`)

if (phase === "fill") {
  const sqlite = await openSqlite(file)
  resetSearchIndex(sqlite.database)
  const batches: { step: string; ms: number }[] = []
  let last = performance.now()
  const t0 = last
  const filled = fillSearchIndex(sqlite.database, {
    onBatch: (step: string) => {
      const now = performance.now()
      batches.push({ step, ms: now - last })
      last = now
    },
  })
  const total = performance.now() - t0
  sqlite.database.close()
  const worst = (step: string) => Math.max(0, ...batches.filter((one) => one.step === step).map((one) => one.ms))
  out()
  out(`**store fill ${RUNTIME} ${N.toLocaleString("en")}** — \`resetSearchIndex\` then \`fillSearchIndex\`, batches of 5,000`)
  out()
  out(
    `${(total / 1000).toFixed(1)} s total (target ≤ 20 s at 1M); ${filled.indexed.toLocaleString("en")} indexed, ` +
      `${filled.terms.toLocaleString("en")} terms; slowest batch: ` +
      [...new Set(batches.map((one) => one.step))].map((step) => `${step} ${fmt(worst(step))} ms`).join(", ") +
      " (target ≤ 500 ms)",
  )
  process.exit(0)
}

const any = { mode: "any", beginnings: false, limit: LIMIT }
const pickOf = (sets: string[][]) => (i: number) => sets[i % sets.length] as string[]
if (phase === "search") {
  const store = await openStore({ path: file })
  await store.searchIndex.fillSearchIndex()
  const all = { accounts }

  out()
  out(`**store search chain ${RUNTIME} ${N.toLocaleString("en")}** — through \`openStore\`, limit ${LIMIT}, ${ROUNDS} rounds`)
  out()
  out("| query | p50 ms | p95 ms | target p95 |")
  out("|---|---|---|---|")

  const day = 86_400_000
  const scopes = filters(meta).map((filter) => {
    const scope: Record<string, unknown> = { accounts }
    if (filter.chat !== undefined) scope.chat = chatScope(filter.chat)
    if (filter.sender !== undefined) scope.sender = { provider: "max", id: String(filter.sender) }
    if (filter.from !== undefined) scope.after = filter.from * 1000
    if (filter.to !== undefined) scope.before = filter.to * 1000 + day
    return { label: filter.label, scope }
  })
  const classes: [string, string[][]][] = [
    ["2 words ~1% df", meta.queries.typical],
    ["2 words 5–15% df", meta.queries.common],
    ["3 words", meta.queries.three],
  ]

  let everyWorst = 0
  let bothWorst = 0
  for (const [label, sets] of classes) {
    const pick = pickOf(sets)
    for (const { label: where, scope } of scopes) {
      const every = { mode: "every", beginnings: false, limit: LIMIT }
      const whole = await timed((i) => store.matchWords(words(pick(i)), scope, every))
      const both = await timed(async (i) => {
        await store.matchWords(words(pick(i)), scope, every)
        await store.matchWords(words(pick(i)), scope, { ...every, beginnings: true })
      })
      everyWorst = Math.max(everyWorst, pctl(whole, 95))
      bothWorst = Math.max(bothWorst, pctl(both, 95))
      row(`every word, ${label} — ${where}`, whole, "≤ 45")
      row(`every word + beginnings, ${label} — ${where}`, both, "≤ 60")
    }
  }

  const common = pickOf(meta.queries.common)
  const anyRows: [string, Record<string, unknown>, string][] = [
    [`any word, small chat (${meta.smallChatCount} msgs)`, { accounts, chat: chatScope(meta.smallChat) }, "≤ 15"],
    [`any word, one sender (max, sender ${meta.sender})`, { accounts, sender: { provider: "max", id: String(meta.sender) } }, "≤ 15"],
    ["any word, all chats", all, "≤ 130"],
    ["any word, the 50% chat", { accounts, chat: chatScope(meta.bigChat) }, "≤ 160"],
  ]
  for (const [label, scope, target] of anyRows) {
    row(`${label}, 2 words 5–15% df`, await timed((i) => store.matchWords(words(common(i)), scope, any)), target)
  }

  const nothing = [["qxzvbnq", "wqxzptq"], ["zzqxvw", "pqxjwz"], ["xqvzbt", "jqzxwv"]]
  row(
    "the whole chain, every word finds nothing — all chats",
    await timed((i) => search(store, words(nothing[i % nothing.length] as string[]), all, { limit: LIMIT })),
    "≤ 200",
  )
  row(
    "typo correction alone (the four typos)",
    await timed((i) => correctWords(store, [(FUZZY[i % FUZZY.length] as { query: string }).query])),
    "≤ 20",
  )
  out()
  out(`Worst p95: every word ${fmt(everyWorst)} ms (≤ 45), every word + beginnings ${fmt(bothWorst)} ms (≤ 60).`)

  out()
  out(`**typo correction ${RUNTIME} ${N.toLocaleString("en")}** — the search's answer to each typo, look-alike words planted`)
  out()
  out("| typo | answered by | corrected to | hits | recall | precision |")
  out("|---|---|---|---|---|---|")
  for (const { query, truthKey } of FUZZY) {
    const wanted = truth[truthKey] ?? []
    const found = await search(store, words([query]), all, { limit: wanted.length * 3 + LIMIT })
    const ids = new Set(found.items.map((hit: { id: string }) => Number(hit.id)))
    const hit = wanted.filter((id) => ids.has(id)).length
    out(
      `| ${query} | ${[...new Set(found.items.map((one: { match: string }) => one.match))].join(", ")} | ${found.corrections.map((one: { to: string[] }) => one.to.join(", ")).join("; ")} | ${ids.size} | ` +
        `${((hit / Math.max(1, wanted.length)) * 100).toFixed(0)}% | ${((hit / Math.max(1, ids.size)) * 100).toFixed(0)}% |`,
    )
  }
  await store.close()
}

// The two forms `matchWords` (src/store/sqlite/words.ts) chooses between for a named chat, as raw SQL on
// the same file, so both can be timed on every chat size whatever SCOPE_TOKEN_LIMIT says.
const sqlite = await openSqlite(file)
const db = sqlite.database
const accountPks = db.prepare("SELECT pk FROM accounts").all().map((one: { pk: number }) => Number(one.pk))
const chatPk = (chat: number) =>
  Number(
    db
      .prepare("SELECT c.pk FROM chats c JOIN accounts a ON a.pk = c.account_pk WHERE a.provider = ? AND c.native_id = ?")
      .get(sourceOf(chat), String(chat))?.pk,
  )
const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`
const formOf = (token: boolean, pk: number, list: string[], mode: "any" | "every") => {
  const required = list.map(quoted).join(mode === "any" ? " OR " : " AND ")
  const match = token ? `((normalized_text : (${required})) AND (scope : ("c${pk}")))` : `(normalized_text : (${required}))`
  const statement = db.prepare(
    `SELECT m.pk AS pk, f.rank AS score FROM message_words f CROSS JOIN messages m CROSS JOIN chats c
     WHERE message_words MATCH ? AND f.rank MATCH 'bm25(1.0, 0.0)' AND m.pk = f.rowid AND c.pk = m.chat_pk
       AND m.deleted_at IS NULL
       AND m.account_pk IN (${accountPks.join(", ")})${token ? "" : " AND m.chat_pk = ?"}
     ORDER BY f.rank, m.sent_at DESC, m.pk DESC LIMIT ?`,
  )
  return () => (token ? statement.all(match, LIMIT + 1) : statement.all(match, pk, LIMIT + 1))
}
{
  const pk = chatPk(meta.smallChat)
  const query = pickOf(meta.queries.common)(0)
  const keys = (rows: { pk: number }[]) => rows.map((one) => Number(one.pk)).join(",")
  if (keys(formOf(true, pk, query, "any")()) !== keys(formOf(false, pk, query, "any")())) {
    throw new Error("the token and the join forms answer differently — the copy is not what words.ts runs")
  }
  const checked = await openStore({ path: file })
  const stored = await timed(() => checked.matchWords(words(query), { accounts, chat: chatScope(meta.smallChat) }, any))
  await checked.close()
  const [copied] = await inTurns(() => formOf(true, pk, query, "any")(), () => undefined)
  out()
  out(
    `Check: the copied token form ${fmt(pctl(copied, 50))} ms p50 against \`store.matchWords\` ${fmt(pctl(stored, 50))} ms ` +
      `on the small chat, one query; both forms return the same rows.`,
  )
}
const sized = [
  { chat: meta.smallChat, count: meta.smallChatCount },
  ...(meta.sizedChats ?? []),
  { chat: meta.bigChat, count: Number(db.prepare("SELECT message_count AS n FROM chats WHERE pk = ?").get(chatPk(meta.bigChat))?.n) },
]
out()
out(`**scope token against the join ${RUNTIME} ${N.toLocaleString("en")}** — a named chat, raw SQL, p95 ms (SCOPE_TOKEN_LIMIT is ${SCOPE_TOKEN_LIMIT.toLocaleString("en")})`)
out()
out("| chat | any word, common: token / join | every word, ~1%: token / join | every word, common: token / join |")
out("|---|---|---|---|")
for (const { chat, count } of sized) {
  const pk = chatPk(chat)
  const cells: string[] = []
  for (const [sets, mode] of [[meta.queries.common, "any"], [meta.queries.typical, "every"], [meta.queries.common, "every"]] as const) {
    const pick = pickOf(sets)
    const [token, join] = await inTurns(
      (i) => formOf(true, pk, pick(i), mode)(),
      (i) => formOf(false, pk, pick(i), mode)(),
    )
    cells.push(`${fmt(pctl(token, 95))} / ${fmt(pctl(join, 95))}`)
  }
  out(`| ${count.toLocaleString("en")} messages | ${cells.join(" | ")} |`)
}
sqlite.database.close()
