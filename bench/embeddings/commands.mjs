// Phase 5 item 8: embed and search time through the real commands, on the first N rows of
// bench/search's corpus as one group chat with invented replies, as bench/disentangle/scale.ts reads it.
// After `pnpm build`; the model is the real one from the shared folder (`models text download e5-small`).
//   node commands.mjs setup <dir> <N>                 a store of N messages in <dir>
//   node|bun commands.mjs run <dir> <command words…>   one command, as a CLI would run it
//   node|bun commands.mjs warm <dir> <runs> <query>    one process searching again and again, as `mcp` does
import { createReadStream } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const root = process.env.BENCH_ROOT ?? new URL("../..", import.meta.url).pathname
const dist = (path) => import(join(root, "dist", path))
const [{ run }, { conversationsCommand }, { settingsFor }, { rememberAccount }, { openStore }] = await Promise.all([
  dist("cli/program.js"),
  dist("cli/messenger/conversations-command.js"),
  dist("cli/settings.js"),
  dist("cli/messenger/accounts.js"),
  dist("store/store.js"),
])
// The same folder as bench/search/common.ts, which Bun and Node cannot both import as TypeScript.
const DATA_DIR =
  process.env.SEARCHBENCH_DATA ??
  join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME, ".cache"), "cli-core", "searchbench")

const app = { command: "bench", appName: "bench-cli", envPrefix: "BENCH", description: "bench", version: "0.0.0" }
const messenger = {
  app,
  provider: "bench",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("the bench never connects")
  },
  chatArgument: "a chat id",
}
const account = { provider: "bench", account: "500" }
const CHAT = "1"

const [mode, dir, ...rest] = process.argv.slice(2)
process.env.MESSAGING_STORE = join(dir, "messages.db")
process.env.BENCH_STATE_DIR = join(dir, "state")
process.env.BENCH_CONFIG_DIR = join(dir, "config")
process.env.BENCH_CACHE_DIR = join(dir, "cache")

const random = (() => {
  let seed = 42
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
})()

if (mode === "setup") {
  const n = Number(rest[0])
  rememberAccount(app, "default", account.account, process.env)
  const store = await openStore({ path: process.env.MESSAGING_STORE })
  await store.saveChats(account, [
    { id: CHAT, title: "Bench", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  const start = Date.parse("2026-01-01T00:00:00Z")
  const ids = []
  let batch = []
  const lines = createInterface({ input: createReadStream(join(DATA_DIR, "corpus-1000000.tsv")) })
  for await (const line of lines) {
    const [id, , sender, , , text] = line.split("\t")
    const index = ids.length
    const back = index === 0 ? undefined : ids[index - 1 - Math.floor(random() * Math.min(index, 50))]
    ids.push(id)
    batch.push({
      id,
      chatId: CHAT,
      senderId: sender,
      senderName: `u${sender}`,
      timestamp: new Date(start + index * 20_000).toISOString(),
      editedAt: null,
      text,
      outgoing: false,
      attachments: [],
      replyTo: null,
      ...(back && random() < 0.6 ? { replyToId: back } : {}),
      forwardedFrom: null,
      reactions: null,
    })
    if (batch.length === 10_000 || ids.length === n) {
      await store.saveMessages(account, CHAT, batch, { via: "history" })
      batch = []
    }
    if (ids.length === n) break
  }
  lines.close()
  await store.close()
  console.error(`stored ${ids.length} messages`)
} else if (mode === "run") {
  process.exitCode = await run(rest, { app, commands: () => [conversationsCommand(messenger)] })
} else if (mode === "warm") {
  const [{ storedDeps }, { embeddingsService }, { warmEmbedders }] = await Promise.all([
    dist("services/deps.js"),
    dist("services/embeddings.js"),
    dist("embeddings/embed.js"),
  ])
  const [runs, query] = [Number(rest[0]), rest.slice(1).join(" ")]
  const store = await openStore({ path: process.env.MESSAGING_STORE })
  const embedders = warmEmbedders()
  const search = embeddingsService({ ...storedDeps(messenger, store, account, {}), embedders })
  const times = []
  for (let index = 0; index < runs; index++) {
    const started = performance.now()
    await search.search(query, { limit: 10 })
    times.push(performance.now() - started)
  }
  await embedders.close()
  await store.close()
  const later = times.slice(1).sort((a, b) => a - b)
  console.log(
    JSON.stringify({ first: Math.round(times[0]), median: Math.round(later[Math.floor(later.length / 2)] ?? 0) }),
  )
}
