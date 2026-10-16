// Phase 3 item 7, the store part: how long `replaceConversations` holds the write lock for one chat of
// N messages, and the longest another process waited for the write lock meanwhile (it gives up at 5 s).
// Same invented chat as scale.ts.
// Usage: pnpm build, then node --experimental-strip-types rebuild.ts <N> <scratch file>
import { createReadStream, rmSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Worker } from "node:worker_threads"
import type { LinkInput } from "../../src/conversations/link.ts"
import { DATA_DIR, mulberry32 } from "../search/common.ts"

// The built package, as bench/search/store.ts: the sources import each other as .js.
const { openCache, openStore } = await import("../../dist/store/index.js")
const { linkMessages, RULES_VERSION } = await import("../../dist/conversations/link.js")

const [nArg, file] = process.argv.slice(2)
const n = Number(nArg)
if (!Number.isSafeInteger(n) || !file) throw new Error("usage: rebuild.ts <N> <scratch file>")
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })

const ACCOUNT = { provider: "tg", account: "1" } as const
const setup = await openStore({ path: file })
await setup.chats.saveChats(ACCOUNT, [
  { id: "-1", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
])
await setup.close()

const random = mulberry32(42)
const database = await openCache(file)
const insert = database.prepare(
  `INSERT INTO messages (account_pk, chat_pk, native_id, sender_chat_native_id, text, sent_at, reply_to_native_id,
     ingested_at, ingested_via) VALUES (1, 1, ?, ?, ?, ?, ?, 0, 'history')`,
)
const start = Date.parse("2026-01-01T00:00:00Z")
let index = 0
database.exec("BEGIN")
const lines = createInterface({ input: createReadStream(join(DATA_DIR, "corpus-1000000.tsv")) })
for await (const line of lines) {
  const [, , sender, , , text] = line.split("\t") as string[]
  const back = index === 0 ? null : index - 1 - Math.floor(random() * Math.min(index, 50))
  const reply = back !== null && random() < 0.6 ? String(back) : null
  insert.run(String(index), String(sender), String(text), start + index * 20_000, reply)
  if (++index === n) break
  if (index % 50_000 === 0) database.exec("COMMIT; BEGIN")
}
lines.close()
database.exec("COMMIT")
database.close()

const store = await openStore({ path: file })
const read = performance.now()
const inputs: LinkInput[] = []
let after: string | undefined
for (;;) {
  const page = await store.conversations.linkInputs(ACCOUNT, "-1", { limit: 5_000, ...(after === undefined ? {} : { after }) })
  inputs.push(...page.items)
  if (page.next === null) break
  after = page.next
}
const readMs = performance.now() - read
const rules = performance.now()
const { links, conversations } = linkMessages(inputs, { handles: await store.conversations.senderHandles(ACCOUNT, "-1") })
const rulesMs = performance.now() - rules

// Another process's view: a small write every 10 ms, and the longest it waited for the lock.
const WRITER = `
const { parentPort, workerData } = require("node:worker_threads")
const { DatabaseSync } = require("node:sqlite")
const db = new DatabaseSync(workerData)
db.exec("PRAGMA busy_timeout = 60000")
let longest = 0
let running = true
parentPort.on("message", () => { running = false })
const tick = () => {
  if (!running) return parentPort.postMessage(longest)
  const at = performance.now()
  db.exec("BEGIN IMMEDIATE; COMMIT")
  longest = Math.max(longest, performance.now() - at)
  setTimeout(tick, 10)
}
tick()
`

const timeWrite = async () => {
  const writer = new Worker(WRITER, { eval: true, workerData: file })
  const at = performance.now()
  await store.conversations.replaceConversations(ACCOUNT, "-1", { startedAt: Date.now(), algorithmVersion: RULES_VERSION, links, conversations })
  const took = performance.now() - at
  const waited = await new Promise<number>((resolve) => {
    writer.once("message", resolve)
    writer.postMessage("stop")
  })
  await writer.terminate()
  return { took, waited }
}
const first = await timeWrite()
const again = await timeWrite()
await store.close()
const s = (ms: number) => `${(ms / 1000).toFixed(2)} s`
console.log(
  `| ${n.toLocaleString("en")} | ${s(readMs)} | ${s(rulesMs)} | ${s(first.took)} / ${s(first.waited)} | ` +
    `${s(again.took)} / ${s(again.waited)} | ` +
    `${links.length.toLocaleString("en")} | ${conversations.length.toLocaleString("en")} | ` +
    `${Math.round(process.resourceUsage().maxRSS / 1024)} MB |`,
)
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true })
