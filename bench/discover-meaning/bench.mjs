// usage: node bench/discover-meaning/bench.mjs <messages>  (after `pnpm build`)
// A fresh temporary store of synthetic messages, each given a random 384-number vector as e5-small's, then
// `--discover` timed by words alone, with meaning on a cold model (a one-shot CLI) and on a warm one (the MCP
// server). The model is read from WIRECAT_MODELS (default: the shared models folder); the store never is.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

const N = Number(process.argv[2] ?? 10_000)
const real = process.env.WIRECAT_MODELS ?? join(homedir(), ".local/share/WireCat/models/text")
const state = mkdtempSync(join(tmpdir(), "discover-meaning-bench-"))
mkdirSync(join(state, "models", "text"), { recursive: true })
symlinkSync(join(real, "e5-small"), join(state, "models", "text", "e5-small"))
process.env.WIRECAT_STATE_DIR = state
process.env.HOME = state

const dist = new URL("../../dist/", import.meta.url)
const { openStore } = await import(new URL("store/store.js", dist))
const { storedDeps } = await import(new URL("services/deps.js", dist))
const { searchStore } = await import(new URL("services/messages-archive-search.js", dist))
const { meaningLane } = await import(new URL("services/messages-meaning.js", dist))
const { warmEmbedders } = await import(new URL("embeddings/embed.js", dist))

let seed = 7
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
const VOCAB = Array.from({ length: 5000 }, (_, i) => `w${i.toString(36)}`)
const words = (n) => Array.from({ length: n }, () => VOCAB[Math.floor(rand() ** 2 * VOCAB.length)]).join(" ")
const unit = () => {
  const v = new Float32Array(384)
  let s = 0
  for (let i = 0; i < v.length; i++) s += (v[i] = rand() - 0.5) ** 2
  return v.map((x) => x / Math.sqrt(s))
}

const account = { provider: "bench", account: "1" }
const store = await openStore({ path: join(state, "bench.db") })
const CHATS = 50
await store.chats.saveChats(
  account,
  Array.from({ length: CHATS }, (_, i) => ({
    id: String(i),
    title: `Chat ${i}`,
    kind: "group",
    unreadCount: 0,
    lastMessageAt: null,
    participantsCount: 10,
  })),
)
const started = Date.parse("2025-01-01T00:00:00Z")
for (let chat = 0; chat < CHATS; chat++) {
  const per = Math.ceil(N / CHATS)
  const messages = Array.from({ length: per }, (_, i) => ({
    id: String(chat * per + i + 1),
    chatId: String(chat),
    senderId: String(100 + (i % 7)),
    senderName: `Sender ${i % 7}`,
    timestamp: new Date(started + (chat * per + i) * 60_000).toISOString(),
    editedAt: null,
    text: words(5 + Math.floor(rand() * 25)),
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  }))
  await store.messages.saveMessages(account, String(chat), messages, { via: "history" })
}
await store.searchIndex.fillSearchIndex({})
await store.searchIndex.fillStems({})

const KEY = "local:e5-small:384"
let after = 0
let vectors = 0
for (;;) {
  const page = await store.vectors.messagesToEmbed(account, { model: KEY, after, limit: 5000 })
  if (!page.length) break
  after = page.at(-1).messagePk
  await store.vectors.saveMessageVectors(
    account,
    KEY,
    384,
    page.map(({ messagePk, text, sentAt }, i) => ({
      messagePk,
      hash: `bench-${messagePk}-${i}`,
      length: text.length,
      occurredAt: sentAt,
      vector: unit(),
    })),
  )
  vectors += page.length
}

const messenger = { provider: "bench", app: { command: "bench" } }
const cold = storedDeps(messenger, store, account, {})
const warm = { ...cold, embedders: warmEmbedders() }
const questions = Array.from({ length: 10 }, () => `${words(4)}?`)
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const time = async (lane) => {
  const ms = []
  for (const text of questions) {
    const t = performance.now()
    const found = await searchStore(store, account, { text, discover: true, limit: 20, timezone: "UTC" }, {}, lane)
    ms.push(performance.now() - t)
    if (lane && found.meaningSkipped) throw new Error(found.meaningSkipped.reason)
  }
  return { median: Math.round(median(ms)), max: Math.round(Math.max(...ms)) }
}
const scan = []
for (let i = 0; i < 10; i++) {
  const t = performance.now()
  await store.vectors.nearestMessages(account, { model: KEY, limit: 100, query: unit() })
  scan.push(performance.now() - t)
}
const load = performance.now()
const lane = meaningLane(warm)
await lane("warm up", [account])
const loadMs = Math.round(performance.now() - load)
const result = {
  messages: N,
  vectors,
  words_only_ms: await time(undefined),
  meaning_cold_model_ms: await time(meaningLane(cold)),
  meaning_warm_model_ms: await time(lane),
  nearest_scan_ms: Math.round(median(scan)),
  first_model_load_ms: loadMs,
  rss_mb: Math.round(process.resourceUsage().maxRSS / 1024),
}
console.log(JSON.stringify(result))
await warm.embedders.close()
await store.close()
rmSync(state, { recursive: true, force: true })
