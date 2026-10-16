import { mkdtempSync } from "node:fs"
import { cpus, loadavg, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { openStore } from "../../dist/store/store.js"
import { openSqlite } from "../../dist/store/sqlite/open.js"
import { nearestChunks } from "../../dist/store/sqlite/vectors.js"

const root = mkdtempSync(join(tmpdir(), "search-vector-scan-"))
const path = join(root, "scan.db")
const account = { provider: "synthetic", account: "500" }
const store = await openStore({ path })
await store.chats.saveChats(account, [
  {
    id: "7",
    title: "Synthetic scan",
    kind: "group",
    unreadCount: 0,
    lastMessageAt: "2026-10-01T10:00:00.000Z",
    participantsCount: 1,
  },
])
await store.messages.saveMessages(
  account,
  "7",
  [
    {
      id: "1",
      chatId: "7",
      senderId: "9",
      senderName: null,
      timestamp: "2026-10-01T10:00:00.000Z",
      text: "Synthetic vector scan anchor",
      editedAt: null,
      outgoing: false,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    },
  ],
  { via: "synthetic" },
)
await store.close()
const db = new DatabaseSync(path)
const chat = db.prepare("SELECT pk, account_pk FROM chats WHERE native_id = '7'").get() as {
  pk: number
  account_pk: number
}
const message = (db.prepare("SELECT pk FROM messages WHERE native_id = '1'").get() as { pk: number }).pk
const now = Date.now()
db.prepare(
  "INSERT INTO conversation_state(chat_pk,enabled_at,built_at,algorithm_version,current_build) VALUES (?,?,?,?,1)",
).run(chat.pk, now, now, 2)
const conversation = db.prepare(
  "INSERT INTO conversations(pk,chat_pk,first_message_pk,build,first_at,last_at,message_count,built_at,algorithm_version) VALUES (?,?,?,1,0,0,10,?,2)",
)
const chunk = db.prepare(
  "INSERT INTO conversation_chunks(conversation_pk,ordinal,first_message_pk,last_message_pk,content_hash) VALUES (?,?,?,?,?)",
)
const vector = db.prepare(
  "INSERT INTO chunk_vectors(model,content_hash,dims,vector,created_at) VALUES ('synthetic:384',?,384,?,?)",
)
const dims = 384
const query = new Float32Array(dims).fill(1 / Math.sqrt(dims))
const bytes = Buffer.from(query.buffer)
const opened = await openSqlite(path)
const results = []
const setupStart = performance.now()
let previous = 0
try {
  for (const count of [100_000, 300_000, 1_000_000]) {
    db.exec("BEGIN")
    for (let i = previous; i < count; i++) {
      const id = Math.floor(i / 10) + 1
      const ordinal = i % 10
      const hash = i.toString(16).padStart(64, "0")
      if (!ordinal) conversation.run(id, chat.pk, message, now)
      // Unique vector rows; deterministic unit values vary, without running inference a million times.
      query[0] = (i % 2 ? 1 : -1) / Math.sqrt(dims)
      vector.run(hash, bytes, now)
      chunk.run(id, ordinal, message, message, hash)
    }
    db.exec("COMMIT")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    previous = count
    const times = []
    const before = loadavg()
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      const hits = nearestChunks({ ...opened, now: () => now }, Number(chat.account_pk), {
        model: "synthetic:384",
        query,
        limit: 10,
      })
      if (hits.length !== 10) throw new Error("scan must return ten conversations")
      times.push(performance.now() - start)
    }
    results.push({
      chunks: count,
      conversations: count / 10,
      milliseconds: times,
      medianMs: [...times].sort((a, b) => a - b)[1],
      loadStart: before,
      loadEnd: loadavg(),
      rssMiB: process.memoryUsage().rss / 2 ** 20,
    })
  }
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        cpu: cpus()[0]?.model ?? "unknown",
        threads: cpus().length,
        ramGiB: totalmem() / 2 ** 30,
        node: process.version,
        dims,
        runs: 3,
        method:
          "production nearestChunks with migrated SQLite schema; 10 chunks per conversation; unique vector rows; no inference, summary hydration or freshness checks; first run after checkpoint, next runs warm",
        root,
        elapsedMs: performance.now() - setupStart,
        results,
      },
      null,
      2,
    ),
  )
} finally {
  opened.database.close()
  db.close()
}
