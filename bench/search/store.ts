// Loads the corpus through the real store — openStore and saveMessages over a current file — so what
// phase 1 changes (the migration, the triggers, Drizzle) is measured on the schema users have, not on
// sqlite.ts's own. Needs the package built: `pnpm build` at the repository root.
//
//   node store.ts build N
import { createReadStream, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { DATA_DIR, du, maxRssMb, mb, out, RUNTIME } from "./common.ts"

const { openStore } = await import("../../dist/store/index.js").catch(() => {
  throw new Error("no dist/ — run `pnpm build` at the repository root first")
})

const [phase, nArg] = process.argv.slice(2)
const N = Number(nArg)
const tag = (globalThis as any).Bun ? "bun" : "node"
const dir = join(DATA_DIR, `store-${N}-${tag}`)
const BATCH = 1_000

if (phase !== "build" || !Number.isInteger(N)) throw new Error("usage: node store.ts build N")
if (existsSync(dir)) throw new Error(`${dir} exists`)
mkdirSync(dir, { recursive: true })

const store = await openStore({ path: join(dir, "messages.db") })
const pending = new Map<string, any[]>()
const flush = async (key: string) => {
  const batch = pending.get(key)
  if (!batch?.length) return
  const [provider, chatId] = key.split("\t")
  await store.messages.saveMessages({ provider, account: "bench" }, chatId, batch, { via: "backfill" })
  pending.set(key, [])
}

const t0 = performance.now()
let rows = 0
const lines = createInterface({ input: createReadStream(join(DATA_DIR, `corpus-${N}.tsv`)), crlfDelay: Infinity })
for await (const line of lines) {
  const [id, chat, sender, source, sentAt, text] = line.split("\t")
  const key = `${source}\t${chat}`
  const batch = pending.get(key) ?? []
  batch.push({
    id,
    chatId: chat,
    senderId: sender,
    senderName: `Sender ${sender}`,
    timestamp: new Date(Number(sentAt) * 1000).toISOString(),
    editedAt: null,
    text,
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  })
  pending.set(key, batch)
  if (batch.length >= BATCH) await flush(key)
  rows += 1
}
for (const key of pending.keys()) await flush(key)
const load = performance.now() - t0
await store.close()

out(
  `| store (openStore + saveMessages, schema 12) | ${RUNTIME} | ${N.toLocaleString("en")} | batches of ${BATCH} per chat | ` +
    `${Math.round(rows / (load / 1000)).toLocaleString("en")} rows/s (${(load / 1000).toFixed(2)} s) | FTS by triggers, inline | ` +
    `${mb(du(dir))} | ${maxRssMb()} MB |`,
)
