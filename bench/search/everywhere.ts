// Search latency with words in transcripts, file names and file text, on a synthetic store, through the real
// store and search service of a build. Run it on two builds to compare them:
//
//   node everywhere.ts <repo with dist/> <messages> <files>
//
// Every message has a few words; every 20th file name and text holds the searched words, and one
// spreadsheet of 75k characters repeats them on every row. Nothing here opens the owner's store.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [root, messageCount = "5000", fileCount = "2500"] = process.argv.slice(2)
if (!root) throw new Error("usage: node everywhere.ts <repo with dist/> [messages] [files]")
const { openStore } = await import(join(root, "dist/store/index.js"))
const { searchStore } = await import(join(root, "dist/services/messages.js"))

const WORDS = ["heron", "ledger", "invoice", "river", "квартира", "договор", "оплата", "отчёт", "budget", "census"]
const account = { provider: "telegram", account: "100" }
const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "everywhere-")), "messages.db") })
await store.saveChats(account, [
  { id: "1", title: "Bench", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
])
const messages = Number(messageCount)
const files = Number(fileCount)
const word = (at: number) => WORDS[at % WORDS.length] as string
const batch = []
for (let at = 0; at < messages; at++) {
  const attachments = at < files ? [{ kind: "document", name: `${at % 20 === 0 ? "heron" : "plain"} report ${at}.xlsx` }] : []
  batch.push({
    id: String(at + 1),
    chatId: "1",
    senderId: String(200 + (at % 7)),
    senderName: `person ${at % 7}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + at * 60_000).toISOString(),
    editedAt: null,
    text: `${word(at)} ${word(at * 7 + 3)} note number ${at}`,
    outgoing: false,
    attachments,
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  })
}
for (let at = 0; at < batch.length; at += 1000) await store.saveMessages(account, "1", batch.slice(at, at + 1000), { via: "history" })
const kept = await store.fileAttachments(account, { limit: files + 10 })
for (const [index, file] of kept.entries()) {
  const text =
    index === 0
      ? Array.from({ length: 2_300 }, (_, row) => `Row ${row + 2}: Bird: heron; Count: ${row}`).join("\n")
      : `${index % 20 === 0 ? "heron sighting" : "plain sheet"} row ${index}`
  await store.keepAttachmentText(file.pk, { text, origin: "extracted", extractor: "bench" })
}
await store.fillSearchIndex?.()

const QUERIES = ["heron", "ledger", "heron AND river", "invoice OR census", "квартира", "text:heron", "zzznothing"]
const ROUNDS = 30
const pctl = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] as number
console.log(`${root}  messages=${messages} files=${files}`)
for (const query of QUERIES) {
  const times: number[] = []
  let hits = 0
  for (let round = 0; round < ROUNDS; round++) {
    const started = performance.now()
    const found = await searchStore(store, account, { text: query, language: "lucene", limit: 20, timezone: "UTC" })
    times.push(performance.now() - started)
    hits = found.items.length
  }
  console.log(`${query.padEnd(20)} hits=${String(hits).padStart(2)} p50=${pctl(times, 0.5).toFixed(1)}ms p95=${pctl(times, 0.95).toFixed(1)}ms`)
}
await store.close()
