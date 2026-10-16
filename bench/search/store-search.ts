// Search through the real store, on a file `store.ts build N` made: `openStore().search`, and the same SQL
// run raw through node:sqlite, on the same queries as sqlite.ts. The gap between the two is what Drizzle,
// the row mapping and the async interface cost (phase 1 item 8: under 1 ms at p95).
//
//   node store-search.ts N
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DATA_DIR, fmt, loadMeta, out, pctl, RUNTIME } from "./common.ts"

const dist = join(import.meta.dirname, "../../dist/store")
const { openStore } = await import(join(dist, "index.js"))
const drizzled = existsSync(join(dist, "sqlite/search.js"))

const N = Number(process.argv[2])
const file = join(DATA_DIR, `store-${N}-node`, "messages.db")
if (!Number.isInteger(N) || !existsSync(file)) throw new Error("usage: node store-search.ts N, after `node store.ts build N`")
const { meta } = loadMeta(N)
const LIMIT = 20

const store = await openStore({ path: file })
const raw = new DatabaseSync(file, { readOnly: true })
const rawSearch = drizzled ? await rawSearcher() : undefined

async function rawSearcher() {
  const { openSqlite } = await import(join(dist, "sqlite/open.js"))
  const { matching, newestHits } = await import(join(dist, "sqlite/search.js"))
  const sqlite = await openSqlite(file)
  const context = { ...sqlite, now: Date.now }
  return (text: string) => {
    const { sql, params } = newestHits(context, matching(context, { text }), LIMIT + 1).toSQL()
    return raw.prepare(sql).all(...params)
  }
}

/** Both paths on the same query, taking turns at going first, so neither gets the other's warm cache. */
const time = async (a: (i: number) => unknown, b?: (i: number) => unknown) => {
  const first: number[] = []
  const second: number[] = []
  const timed = async (run: (i: number) => unknown, i: number, into: number[]) => {
    const t = performance.now()
    await run(i)
    into.push(performance.now() - t)
  }
  for (let i = -2; i < 40; i++) {
    const round = i < 0 ? [[], []] : [first, second]
    const order = i % 2 === 0 ? [0, 1] : [1, 0]
    for (const which of order) {
      if (which === 0) await timed(a, Math.abs(i), round[0] as number[])
      else if (b) await timed(b, Math.abs(i), round[1] as number[])
    }
  }
  return [first, b ? second : undefined] as const
}

out()
out(`**store search ${RUNTIME} ${N.toLocaleString("en")}** — ${drizzled ? "Drizzle" : "hand-written SQL"}, limit ${LIMIT}`)
out()
out("| query | store p50 ms | store p95 ms | raw SQL p50 ms | raw SQL p95 ms |")
out("|---|---|---|---|---|")
const classes: [string, string[][]][] = [
  ["2 words ~1% df", meta.queries.typical],
  ["2 words 5–15% df", meta.queries.common],
  ["3 words", meta.queries.three],
]
for (const [label, sets] of classes) {
  const words = (i: number) => (sets[i % sets.length] ?? []).join(" ")
  const [viaStore, viaRaw] = await time(
    (i) => store.messages.search(words(i), { limit: LIMIT }),
    rawSearch && ((i: number) => rawSearch(words(i))),
  )
  out(
    `| ${label} — all | ${fmt(pctl(viaStore, 50))} | ${fmt(pctl(viaStore, 95))} | ` +
      `${viaRaw ? fmt(pctl(viaRaw, 50)) : "—"} | ${viaRaw ? fmt(pctl(viaRaw, 95)) : "—"} |`,
  )
}
raw.close()
await store.close()
