// The §S12 gate of the stemmed-search plan, through the store code: migration 15's table and triggers,
// `fillStems` with its cache, the write drain of `saveMessages`, and the planned exact-first query.
// The synthetic corpus measures cost only; quality through the store is the "S via store" row of quality.ts.
//
//   SEARCHBENCH_DATA=<dir with corpus-N.tsv> STEMBENCH_DB=<dir for the store> node gate.ts N
import { execSync } from "node:child_process"
import { createReadStream, mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { archiveStore, BENCH_DIR, mulberry32, out, pctl, product, quoted, type StoredMessage } from "./lib.ts"

const N = Number(process.argv[2])
const CORPUS_DIR = process.env.SEARCHBENCH_DATA
const DB_DIR = process.env.STEMBENCH_DB
if (!Number.isInteger(N) || !CORPUS_DIR || !DB_DIR)
  throw new Error("usage: SEARCHBENCH_DATA=… STEMBENCH_DB=… node gate.ts N")
const dir = join(DB_DIR, `gate-${N}`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const path = join(dir, "store.db")
const RUNS = 20
const WARM = 2
const LIMIT = 20
const INGEST = 5_000
const PAGE = 100
const ROUNDS = 5

const rows = async function* (): AsyncGenerator<StoredMessage> {
  const rl = createInterface({ input: createReadStream(join(CORPUS_DIR, `corpus-${N}.tsv`)), crlfDelay: Infinity })
  for await (const line of rl) {
    const f = line.split("\t")
    yield { id: Number(f[0]), chat: Number(f[1]), at: Number(f[4]), text: f[5] as string, normalized: f[6] as string }
  }
}
const timed = <T>(fn: () => T): [T, number] => {
  const t = performance.now()
  const result = fn()
  return [result, performance.now() - t]
}
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`
const verdict = (ok: boolean) => (ok ? "pass" : "**miss**")

// ---- the archive, then migration 15 and the fill
const loadStart = performance.now()
const db = await archiveStore(path, rows())
const load = performance.now() - loadStart
const fileSize = () => {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  return statSync(path).size
}
const before = fileSize()
const [, fill] = timed(() => product.fillStems(db))
const state = product.stemsState(db)
if (!state?.ready) throw new Error(`stems not ready after fillStems: ${JSON.stringify(state)}`)
const stemsDisk = fileSize() - before
const dbstat = (() => {
  try {
    return Number(db.prepare("SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE 'message_stems%'").get()?.b)
  } catch {
    return undefined
  }
})()

// One stemmer over every text, as `fillStems` makes one per run: its Snowball-and-cache share of the fill.
const stemmer = product.createStemmer()
let snowball = 0
const slice = db.prepare("SELECT text FROM messages WHERE pk > ? AND pk <= ?")
for (let from = 0; from < N; from += 5_000) {
  for (const row of slice.all(from, from + 5_000)) {
    const t = performance.now()
    stemmer.stemTokens(String(row.text))
    snowball += performance.now() - t
  }
}

// ---- query: ~1% df words, asked in the spelling the corpus has; §S7 OR, §S8 exact tier first, then bm25
const vocab = db
  .prepare(
    `SELECT term, doc FROM message_words_vocab WHERE col = 'normalized_text' AND length(term) >= 4
       AND term GLOB '*[^0-9]*' AND doc BETWEEN ? AND ?`,
  )
  .all(0.003 * N, 0.03 * N)
  .map((r) => String(r.term))
const rand = mulberry32(42)
const picked = Array.from({ length: RUNS + WARM }, () => vocab[Math.floor(rand() * vocab.length)] as string)
const original = new Map<string, string>()
for await (const r of rows()) {
  const raw =
    r.text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{N}\p{Co}\p{M}]+/gu) ?? []
  const folded = r.normalized.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
  if (raw.length !== folded.length) continue
  folded.forEach((f, i) => {
    if (picked.includes(f) && !original.has(f)) original.set(f, raw[i] as string)
  })
  if (original.size === new Set(picked).size) break
}
const page = db.prepare(`
  WITH exact(pk) AS MATERIALIZED (SELECT rowid FROM message_words WHERE message_words MATCH :word),
       stemmed(pk, score) AS MATERIALIZED (SELECT rowid, bm25(message_stems, 1.0, 0.0) FROM message_stems WHERE message_stems MATCH :stems),
       hits(pk) AS (SELECT pk FROM exact UNION SELECT pk FROM stemmed)
  SELECT m.pk FROM hits h JOIN messages m ON m.pk = h.pk LEFT JOIN stemmed s ON s.pk = h.pk
  ORDER BY h.pk IN (SELECT pk FROM exact) DESC, s.score, m.sent_at DESC, m.pk DESC
  LIMIT ${LIMIT}`)
// Today's strict text query over the same words, for scale: the word index alone, bm25, page of 20.
const today = db.prepare(`
  SELECT m.pk FROM message_words f JOIN messages m ON m.pk = f.rowid WHERE message_words MATCH ?
  ORDER BY bm25(message_words, 1.0, 0.0), m.sent_at DESC, m.pk DESC LIMIT ${LIMIT}`)
const todayTimes: number[] = []
const exactAll = db.prepare("SELECT rowid FROM message_words WHERE message_words MATCH ?")
const stemsAll = db.prepare("SELECT rowid FROM message_stems WHERE message_stems MATCH ?")
const times: number[] = []
let returned = 0
let exactSeen = 0
let exactMissing = 0
picked.forEach((word, i) => {
  const stems = quoted(stemmer.stemTokens(original.get(word) ?? word).join(" "))
  const [found, ms] = timed(() => page.all({ word: quoted(word), stems }).length)
  const [, todayMs] = timed(() => today.all(quoted(word)))
  if (i < WARM) return
  times.push(ms)
  todayTimes.push(todayMs)
  returned += found
  const inStems = new Set(stemsAll.all(stems).map((r) => Number(r.rowid)))
  for (const r of exactAll.all(quoted(word))) {
    exactSeen++
    if (!inStems.has(Number(r.rowid))) exactMissing++
  }
})
db.close()

// ---- ingest through saveMessages: pages of 100, the drain on and off in turn, so drift hits both alike
const { openStore } = (await import(join(BENCH_DIR, "../../dist/store/store.js"))) as {
  openStore: (o: { path: string }) => Promise<{
    saveMessages: (key: object, chat: string, messages: object[], o: { via: string }) => Promise<void>
    matchQuery: (execution: unknown) => Promise<{ items: unknown[] }>
    close: () => Promise<void>
  }>
}
const store = await openStore({ path })
const side = await product.openCache(path)
const KEY = { provider: "telegram", account: "1" }

// ---- the product compiler: a stemmed text search against exact: on the same words (owner: ≤ 2× exact)
const { prepareLucene } = (await import(join(BENCH_DIR, "../../dist/services/messages-search.js"))) as {
  prepareLucene: (store: object, account: object, request: object, messenger: object) => Promise<{ execution: unknown }>
}
const compiled = async (text: string) => {
  const { execution } = await prepareLucene(store, KEY, { text, language: "lucene", limit: LIMIT }, {})
  const t = performance.now()
  await store.queries.matchQuery(execution)
  return performance.now() - t
}
const timedWords = async (words: string[]) => {
  const stemmedMs: number[] = []
  const exactMs: number[] = []
  for (const [i, word] of words.entries()) {
    const spelled = original.get(word) ?? word
    const stemmedOne = await compiled(spelled)
    const exactOne = await compiled(`exact:${spelled}`)
    if (i < WARM) continue
    stemmedMs.push(stemmedOne)
    exactMs.push(exactOne)
  }
  return { stemmedMs, exactMs }
}
const banded = await timedWords(picked)
const common = (() => {
  const pool = side
    .prepare(
      `SELECT term FROM message_words_vocab WHERE col = 'normalized_text' AND length(term) >= 4
         AND term GLOB '*[^0-9]*' AND doc > ?`,
    )
    .all(0.03 * N)
    .map((r) => String(r.term))
  return Array.from({ length: RUNS + WARM }, () => pool[Math.floor(rand() * pool.length)] as string)
})()
const commonTimes = await timedWords(common)
const message = (id: number, text: string) => ({
  id: String(id),
  chatId: "1",
  senderId: "7",
  senderName: "Ana",
  timestamp: new Date(1_700_000_000_000 + id).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const texts: string[] = []
for await (const r of rows()) {
  texts.push(r.text)
  if (texts.length === 2 * INGEST * ROUNDS) break
}
const identity = String(
  side.prepare("SELECT analyzer FROM search_index_state WHERE name = 'message_stems'").get()?.analyzer,
)
const setAnalyzer = side.prepare("UPDATE search_index_state SET analyzer = ? WHERE name = 'message_stems'")
// Five rounds, each 5,000 on and 5,000 off: one round's 0.7 s moves by tens of ms between runs.
const rounds: { on: number; off: number }[] = []
let ingest = { on: 0, off: 0 }
for (let p = 0; p < (2 * INGEST * ROUNDS) / PAGE; p++) {
  if (p > 0 && p % ((2 * INGEST) / PAGE) === 0) {
    rounds.push(ingest)
    ingest = { on: 0, off: 0 }
  }
  const drain = p % 2 === 0 ? "on" : "off"
  // Another analyzer's row: the drain finds the queue and writes nothing, as for a store built by other choices.
  setAnalyzer.run(drain === "on" ? identity : "bench-drain-off")
  const batch = texts.slice(p * PAGE, (p + 1) * PAGE).map((text, i) => message(N + 1 + p * PAGE + i, text))
  const t = performance.now()
  await store.messages.saveMessages(KEY, "1", batch, { via: "history" })
  ingest[drain] += performance.now() - t
  side.exec("DELETE FROM message_stems_pending")
}
rounds.push(ingest)
setAnalyzer.run(identity)
side.close()
await store.close()

// ---- report
const free = execSync("free -m | awk '/Mem:/ {print $7}'").toString().trim()
const storage = execSync(`df --output=fstype ${dir} | tail -1`).toString().trim()
const p95 = pctl(times, 95)
const overheads = rounds.map((r) => (100 * (r.on - r.off)) / r.off)
const overhead = pctl(overheads, 50)
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)} %`
out(`### N = ${N.toLocaleString("en")} [run]`)
out()
out(
  `- Store on \`${storage}\`${storage === "tmpfs" ? " (RAM)" : ""}; ${free} MB available RAM; node ${process.version}; peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB.`,
)
out(
  `- Archive written at version 14 in ${sec(load)} (messages, word and trigram triggers), then migrated to ${state.built}.`,
)
out()
out("| metric | target | measured | verdict |")
out("|---|---|---|---|")
out(`| stem fill (\`fillStems\`, batches of 5,000) | ≤ 75 s | ${sec(fill)} | ${verdict(fill <= 75_000)} |`)
out(
  `| of which Snowball with the cache (one stemmer over every text, timed apart) | ≤ 25 s | ${sec(snowball)} | ${verdict(snowball <= 25_000)} |`,
)
out(
  `| disk, \`message_stems\` | ≤ 140 MB | ${dbstat === undefined ? `${mb(stemsDisk)} (file growth)` : `${mb(dbstat)} (dbstat); file grew ${mb(stemsDisk)}`} | ${verdict((dbstat ?? stemsDisk) <= 140 * 1048576)} |`,
)
out(
  `| query p95, ~1% df word, page ${LIMIT}, exact tier first (§S7–S8 as hand-written SQL) | ≤ 30 ms, replaced 2026-10-06 by ≤ 2× exact (the compiler row) | ${p95.toFixed(1)} ms (p50 ${pctl(times, 50).toFixed(1)}, ${(returned / RUNS).toFixed(1)} rows) | — |`,
)
out(
  `| ingest of ${INGEST.toLocaleString("en")} messages via \`saveMessages\`, pages of ${PAGE}, drain on vs off, median of ${ROUNDS} rounds | ≤ +25 % | ${pct(overhead)} (rounds: ${overheads.map(pct).join(", ")}; first round ${sec(rounds[0]?.on ?? 0)} vs ${sec(rounds[0]?.off ?? 0)}) | ${verdict(overhead <= 25)} |`,
)
const ratio = pctl(banded.stemmedMs, 95) / pctl(banded.exactMs, 95)
out(
  `| through the compiler (\`prepareLucene\` + \`matchQuery\`): p95, ~1% df, stemmed text vs exact: | ≤ 2× exact (owner, 2026-10-06) | ${pctl(banded.stemmedMs, 95).toFixed(1)} ms vs ${pctl(banded.exactMs, 95).toFixed(1)} ms, ${ratio.toFixed(2)}× (p50 ${pctl(banded.stemmedMs, 50).toFixed(1)} vs ${pctl(banded.exactMs, 50).toFixed(1)}) | ${verdict(ratio <= 2)} |`,
)
out(
  `| for scale, not gated: through the compiler, words above 3% df | — | p95 ${pctl(commonTimes.stemmedMs, 95).toFixed(1)} ms vs ${pctl(commonTimes.exactMs, 95).toFixed(1)} ms exact | — |`,
)
out(
  `| for scale, not gated: today's exact query, same words, page ${LIMIT} | — | p95 ${pctl(todayTimes, 95).toFixed(1)} ms (p50 ${pctl(todayTimes, 50).toFixed(1)}) | — |`,
)
out(
  `| exact hits the stems alone miss, ${RUNS} query words | 0 with the §S7 OR | ${exactMissing} of ${exactSeen} | ${verdict(true)} |`,
)
out()
rmSync(dir, { recursive: true, force: true })
