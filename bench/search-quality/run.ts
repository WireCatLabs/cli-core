import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { cpus, loadavg, platform, release, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { cutChunks } from "../../dist/conversations/chunks.js"
import { openEmbedder, textModelsDirectory, warmEmbedders } from "../../dist/embeddings/embed.js"
import { textModel } from "../../dist/embeddings/models.js"
import { storedDeps } from "../../dist/services/deps.js"
import { conversationsService } from "../../dist/services/conversations.js"
import { embeddingsService, vectorModelKey } from "../../dist/services/embeddings.js"
import { openStore } from "../../dist/store/store.js"

import type { Messenger } from "../../dist/cli/messenger/context.js"
import { settingsFor } from "../../dist/cli/settings.js"
import type { Message } from "../../dist/domain/models.js"
import type { SendGuard } from "../../dist/sends/guard.js"
import type { FoundConversation } from "../../dist/services/embeddings.js"
import type { ConversationHit } from "../../dist/store/store.js"

type Query = { id: string; split: "dev" | "test"; category: string; text: string; relevant: string[] }
type Measured = Query & { meaning: ConversationHit[]; words: FoundConversation[]; hybrid: FoundConversation[] }
type Ranked = Pick<ConversationHit, "summary" | "chunk"> & { score: number | null; rrf: number }
type Metrics = { recallAt5: number; precisionAt5: number; noAnswerQueryHitRate: number }
type Mode = "words" | "meaning" | "hybrid"
type FullMetrics = Metrics & { answered: number; noAnswerQueries: number; mrr: number; noAnswerHits: number }
type Corpus = { documents: { id: string; chat: string; texts: string[] }[]; queries: Query[] }

const corpusPath = new URL("./corpus.json", import.meta.url)
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus
const root = mkdtempSync(join(tmpdir(), "search-quality-"))
const account = { provider: "synthetic", account: "500" }
const app = {
  command: "bench",
  appName: "bench-cli",
  envPrefix: "BENCH",
  description: "Synthetic quality",
  version: "0.0.0",
}
const messenger: Messenger = {
  resolveSettings: settingsFor(app).resolveSettings,
  app,
  provider: account.provider,
  history: "store",
  chatArgument: "chat id",
  connect: async () => {
    throw new Error("benchmark never connects")
  },
}
const store = await openStore({ path: join(root, "quality.db") })
const model = textModel("e5-small")
const warm = warmEmbedders()
const realEnv = { ...process.env, MESSAGING_STORE: join(root, "quality.db") }
const deps = { ...storedDeps(messenger, store, account, {} as SendGuard), env: realEnv, embedders: warm }
const service = embeddingsService(deps)
const wordsOnly = embeddingsService({ ...deps, env: { ...realEnv, WIRECAT_STATE_DIR: join(root, "no-model") } })
const started = performance.now()
const initialLoad = loadavg()
const key = vectorModelKey(model)
const directory = textModelsDirectory(realEnv)
for (const file of model.files) {
  const actual = createHash("sha256")
    .update(readFileSync(join(directory, model.id, file.name)))
    .digest("hex")
  assert.equal(actual, file.sha256, `real cached model file ${file.name} must match the pinned catalogue`)
}
const byMessage = new Map<string, string>()
const sizes = new Map<string, number>()
try {
  for (const chatId of [...new Set(corpus.documents.map((d) => d.chat))]) {
    await store.chats.saveChats(account, [
      {
        id: chatId,
        title: `Synthetic group ${chatId}`,
        kind: "group",
        unreadCount: 0,
        lastMessageAt: "2026-10-01T10:00:00.000Z",
        participantsCount: 100,
      },
    ])
    const documents = corpus.documents.filter((d) => d.chat === chatId)
    const messages: Message[] = documents
      .flatMap((d, i) =>
        d.texts.map((text, j) => {
          const id = String(Number(d.id) * 10 + j)
          byMessage.set(id, d.id)
          return {
            id,
            chatId,
            senderId: String(1000 + i * 2 + j),
            senderName: j ? "Synthetic B" : "Synthetic A",
            timestamp: new Date(Date.UTC(2026, 9, 1, 10, j, i)).toISOString(),
            editedAt: null,
            text,
            outgoing: false,
            attachments: text ? [] : [{ kind: "photo" }],
            replyTo: null,
            ...(j ? { replyToId: String(Number(d.id) * 10) } : {}),
            forwardedFrom: null,
            reactions: null,
          }
        }),
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    await store.messages.saveMessages(account, chatId, messages, { via: "synthetic" })
    await conversationsService(deps).build(chatId)
    sizes.set(chatId, documents.length)
  }
  const embedder = await warm.get(key, () => openEmbedder(model, textModelsDirectory(realEnv), { threads: 8 }))
  for (const [chatId, size] of sizes) {
    const summaries = (await store.conversations.conversations(account, chatId, { limit: size + 1 })).items
    assert.equal(summaries.length, size, "each labelled document must be one built conversation")
    for (const summary of summaries) {
      const found = await store.conversations.conversation(account, summary.id)
      assert.ok(found)
      const chunks = cutChunks(found.messages.map((m) => ({ id: m.id, sender: m.senderName, text: m.text })))
      const vectors = await embedder.embed(
        chunks.map((c) => c.text),
        "passage",
      )
      await store.vectors.saveVectors(
        key,
        model.dims,
        chunks.map((c, i) => ({ hash: c.hash, vector: vectors[i] as Float32Array })),
      )
    }
  }
  const measured: Measured[] = []
  for (const query of corpus.queries) {
    const [vector] = await embedder.embed([query.text], "query")
    const meaning = await store.vectors.nearestConversations(account, { model: key, limit: 100, query: vector as Float32Array })
    const words = (await wordsOnly.search(query.text, { limit: 100 })).hits
    const hybrid = (await service.search(query.text, { limit: 100 })).hits
    assert.deepEqual(
      fuse(
        meaning.filter(({ score }) => score > 0.8),
        words,
      ).map((h) => h.summary.id),
      hybrid.map((h) => h.summary.id),
      "measured e5 floor and RRF must match production",
    )
    measured.push({ ...query, meaning, words, hybrid })
  }
  const floors = [-1, 0, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]
  const reports = floors.map((floor) => ({
    floor,
    dev: report(
      measured.filter((q) => q.split === "dev"),
      floor,
    ),
    test: report(
      measured.filter((q) => q.split === "test"),
      floor,
    ),
  }))
  // Choose only from dev; held-out rows never affect this comparison.
  const baseline = reports[0]
  assert.ok(baseline)
  const eligible = reports.filter((row) => row.dev.hybrid.recallAt5 >= baseline.dev.hybrid.recallAt5)
  const chosen = [...eligible].sort((a, b) => objective(b.dev.hybrid) - objective(a.dev.hybrid) || a.floor - b.floor)[0]
  assert.ok(chosen)
  const selected = chosen.floor
  assert.equal(selected, 0.8, "production e5 floor must match the dev selection")
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        model: { id: model.id, key, files: model.files.map(({ name, sha256 }) => ({ name, sha256 })) },
        productionSha256: createHash("sha256")
          .update(readFileSync(new URL("../../dist/services/embeddings.js", import.meta.url)))
          .digest("hex"),
        corpusSha256: createHash("sha256").update(readFileSync(corpusPath)).digest("hex"),
        machine: {
          cpu: cpus()[0]?.model ?? "unknown",
          threads: cpus().length,
          ramGiB: totalmem() / 2 ** 30,
          platform: platform(),
          release: release(),
          node: process.version,
          loadStart: initialLoad,
          loadEnd: loadavg(),
        },
        documents: corpus.documents.length,
        queries: measured.length,
        k: 5,
        precisionDenominator: "k even when fewer hits are returned",
        selectedOnDev: selected,
        objective:
          "hybrid F1 minus no-answer query hit rate, subject to preserving baseline hybrid dev recall; dev only",
        results: reports,
        rankings: measured.map((q) => ({
          id: q.id,
          split: q.split,
          category: q.category,
          relevant: q.relevant,
          meaning: q.meaning.map((h) => ({ document: documentOf(h.summary.firstMessageId), score: h.score })),
          words: q.words.map((h) => documentOf(h.summary.firstMessageId)),
        })),
        elapsedMs: performance.now() - started,
      },
      null,
      2,
    ),
  )
} finally {
  await warm.close()
  await store.close()
}

function fuse(meaning: ConversationHit[], words: FoundConversation[]) {
  const held = new Map<string, Ranked>(meaning.map((hit, i) => [hit.summary.id, { ...hit, rrf: 1 / (61 + i) }]))
  words.forEach((hit, i) => {
    const found = held.get(hit.summary.id)
    if (found) found.rrf += 1 / (61 + i)
    else held.set(hit.summary.id, { ...hit, score: null, rrf: 1 / (61 + i) })
  })
  return [...held.values()].sort((a, b) => b.rrf - a.rrf || (b.score ?? -2) - (a.score ?? -2))
}
function objective(metrics: Metrics) {
  const { recallAt5: r, precisionAt5: p, noAnswerQueryHitRate: n } = metrics
  return (r + p ? (2 * r * p) / (r + p) : 0) - n
}
function report(queries: Measured[], floor: number): Record<Mode, FullMetrics> {
  return Object.fromEntries(
    ["words", "meaning", "hybrid"].map((mode) => {
      let recall = 0,
        precision = 0,
        reciprocal = 0,
        answered = 0,
        falseQueries = 0,
        falseHits = 0,
        negatives = 0
      for (const q of queries) {
        const meaning = q.meaning.filter((h) => h.score > floor)
        const hits = (mode === "words" ? q.words : mode === "meaning" ? meaning : fuse(meaning, q.words))
          .slice(0, 5)
          .map((h) => documentOf(h.summary.firstMessageId))
        if (!q.relevant.length) {
          negatives++
          falseHits += hits.length
          falseQueries += Number(hits.length > 0)
          continue
        }
        answered++
        const matched = new Set(hits.filter((id) => q.relevant.includes(id))).size
        recall += matched / q.relevant.length
        precision += matched / 5
        const rank = hits.findIndex((id) => q.relevant.includes(id))
        reciprocal += rank < 0 ? 0 : 1 / (rank + 1)
      }
      return [
        mode,
        {
          answered,
          noAnswerQueries: negatives,
          recallAt5: recall / answered,
          precisionAt5: precision / answered,
          mrr: reciprocal / answered,
          noAnswerQueryHitRate: falseQueries / negatives,
          noAnswerHits: falseHits,
        },
      ]
    }),
  ) as Record<Mode, FullMetrics>
}

function documentOf(message: string): string {
  const document = byMessage.get(message)
  assert.ok(document, "every result must map to a labelled synthetic document")
  return document
}
