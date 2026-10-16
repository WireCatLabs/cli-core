import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { cpus, platform, release, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Tokenizer } from "@huggingface/tokenizers"
import { type Chunk, type ChunkLine, cutChunks } from "../../dist/conversations/chunks.js"
import { mailCore } from "../../dist/conversations/mail-text.js"
import { openEmbedder, textModelsDirectory } from "../../dist/embeddings/embed.js"
import { textModel } from "../../dist/embeddings/models.js"
import { openStore } from "../../dist/store/store.js"

type Email = { id: string; from: string; at: string; body: string }
type Thread = { id: string; subject: string; emails: Email[] }
type Query = { id: string; split: "dev" | "test"; lang: string; category: string; text: string; relevant: string[] }
type Corpus = { threads: Thread[]; queries: Query[] }
type Variant = { unit: "email" | "thread"; size: number; overlap: number; cleaning: "off" | "rules" }
type Piece = Chunk & { thread: string }
type Scores = { recallAt5: number; mrr: number }

// MAIL_CORPUS names another corpus, such as one export-store.ts made from a real mailbox.
const corpusText = readFileSync(process.env.MAIL_CORPUS ?? new URL("./corpus.json", import.meta.url), "utf8")
const corpus = JSON.parse(corpusText) as Corpus
const threadOf = new Map(corpus.threads.flatMap((t) => t.emails.map((e) => [e.id, t.id] as const)))
for (const query of corpus.queries)
  for (const id of query.relevant) assert.ok(threadOf.has(id), `${query.id} labels unknown email ${id}`)

const PRODUCTION: Variant = { unit: "email", size: 1_200, overlap: 150, cleaning: "rules" }
const every: Variant[] = (["thread", "email"] as const).flatMap((unit) =>
  [600, 1_200, 2_000].flatMap((size) =>
    [0, 150, 300].flatMap((overlap) => (["rules", "off"] as const).map((cleaning) => ({ unit, size, overlap, cleaning }))),
  ),
)
const nameOf = ({ unit, size, overlap, cleaning }: Variant) => `${unit}/${size}/${overlap}/${cleaning}`
// MAIL_VARIANTS=email/1200/150/rules,thread/1200/150/rules measures only those: a real mailbox is too big for all 36.
const chosen = process.env.MAIL_VARIANTS?.split(",").map((name) => name.trim())
const variants = chosen ? every.filter((variant) => chosen.includes(nameOf(variant))) : every
assert.ok(variants.length > 0, `MAIL_VARIANTS names none of ${every.map(nameOf).join(", ")}`)

const titleOf = (subject: string): string | null =>
  subject.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || null

/**
 * Per email, mirrors `threadText` in src/store/sqlite/emails.ts; the store check below fails if the two drift
 * apart. Per thread, as the store cut mail before: the subject only where it changes.
 */
const linesOf = (thread: Thread, { unit, cleaning }: Variant): ChunkLine[] => {
  const earlier: string[] = []
  let topic: string | null = null
  return thread.emails.map((email, i) => {
    const text = cleaning === "rules" ? mailCore(email.body, earlier) : email.body
    earlier.push(email.body)
    const subject = titleOf(i === 0 ? thread.subject : `Re: ${thread.subject}`)
    const line = subject && (unit === "email" || subject !== topic) ? `${subject}\n\n${text}` : text
    topic = subject ?? topic
    return { id: email.id, sender: email.from, text: line }
  })
}

const piecesOf = (variant: Variant): Piece[] =>
  corpus.threads.flatMap((thread) => {
    const lines = linesOf(thread, variant)
    const groups = variant.unit === "thread" ? [lines] : lines.map((line) => [line])
    return groups.flatMap((group) =>
      cutChunks(group, variant.size, undefined, variant.unit === "thread" ? variant.overlap : 0, variant.overlap).map(
        (chunk) => ({ ...chunk, thread: thread.id }),
      ),
    )
  })

const sameAsStore = async (pieces: Piece[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "mail-quality-")), "store.db") })
  try {
    const accountId = await store.accounts.saveAccount({ provider: "email", account: "owner@example.com" }, { name: null })
    for (const thread of corpus.threads)
      await store.mail.saveThread({
        accountId,
        externalId: thread.id,
        now: Date.parse("2026-10-01T00:00:00Z"),
        emails: thread.emails.map((email, i) => ({
          externalId: `<${email.id}@example.com>`,
          subject: i === 0 ? thread.subject : `Re: ${thread.subject}`,
          from: { address: `${email.id}@example.com`, name: email.from },
          to: [{ address: "owner@example.com", name: null }],
          sentAt: Date.parse(email.at),
          receivedAt: Date.parse(email.at),
          bodyText: email.body,
        })),
      })
    const stored = await store.mail.chunksToEmbed("bench:none:0", { limit: 100_000 })
    assert.deepEqual(
      stored.map((c) => c.hash).sort(),
      [...new Set(pieces.map((p) => p.hash))].sort(),
      "the benchmark must cut mail exactly as the store does",
    )
  } finally {
    await store.close()
  }
}

const model = textModel("e5-small")
const directory = textModelsDirectory(process.env)
const path = (name: string) => join(directory, model.id, name)
for (const file of model.files) {
  const actual = createHash("sha256").update(readFileSync(path(file.name))).digest("hex")
  assert.equal(actual, file.sha256, `cached model file ${file.name} must match the pinned catalogue`)
}
const tokenizer = new Tokenizer(
  JSON.parse(readFileSync(path("tokenizer.json"), "utf8")),
  JSON.parse(readFileSync(path("tokenizer_config.json"), "utf8")),
)
const embedder = await openEmbedder(model, directory, { threads: 8 })
const vectors = new Map<string, Float32Array>()
let embeddedChars = 0
let embeddingMs = 0
const embed = async (pieces: Piece[]) => {
  const missing = [...new Map(pieces.filter((p) => !vectors.has(p.hash)).map((p) => [p.hash, p.text])).entries()]
  const started = performance.now()
  for (const [hash, text] of missing) {
    const [vector] = await embedder.embed([text], "passage")
    vectors.set(hash, vector as Float32Array)
    embeddedChars += text.length
  }
  embeddingMs += performance.now() - started
}
const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number)
  return sum
}

/** Emails ranked as `nearest` ranks them: each piece stands for the newest email in it. */
const rankEmails = (scored: { piece: Piece; score: number }[]) => [...new Set(scored.map(({ piece }) => piece.lastId))]
const order = new Map(corpus.threads.flatMap((t) => t.emails.map((e, i) => [e.id, i] as const)))
const emailsOf = new Map(corpus.threads.map((t) => [t.id, t.emails.map((e) => e.id)]))
/** The alternative: a piece stands for every email it holds, newest first. */
const rankEveryEmail = (scored: { piece: Piece; score: number }[]) => [
  ...new Set(
    scored.flatMap(({ piece }) =>
      (emailsOf.get(piece.thread) ?? [])
        .slice(order.get(piece.firstId), (order.get(piece.lastId) ?? 0) + 1)
        .reverse(),
    ),
  ),
]
const rankThreads = (scored: { piece: Piece; score: number }[]) => [...new Set(scored.map(({ piece }) => piece.thread))]
const scoresOf = (ranks: (number | null)[]): Scores => ({
  recallAt5: ranks.filter((r) => r !== null && r < 5).length / ranks.length,
  mrr: ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / (r + 1)), 0) / ranks.length,
})
const firstOf = (ranked: string[], wanted: string[]) => {
  const at = ranked.findIndex((id) => wanted.includes(id))
  return at === -1 ? null : at
}

const queryVectors = new Map<string, Float32Array>()
for (const query of corpus.queries)
  queryVectors.set(query.id, (await embedder.embed([query.text], "query"))[0] as Float32Array)

const results = []
for (const variant of variants) {
  const pieces = piecesOf(variant)
  if (JSON.stringify(variant) === JSON.stringify(PRODUCTION)) await sameAsStore(pieces)
  await embed(pieces)
  const unique = [...new Map(pieces.map((p) => [p.hash, p])).values()]
  const cut = unique.filter((p) => tokenizer.encode(`${model.prefix.passage}${p.text}`).ids.length > model.maxTokens)
  const ranks = corpus.queries.map((query) => {
    const vector = queryVectors.get(query.id) as Float32Array
    const scored = pieces
      .map((piece) => ({ piece, score: dot(vector, vectors.get(piece.hash) as Float32Array) }))
      .sort((a, b) => b.score - a.score)
    const threads = [...new Set(query.relevant.map((id) => threadOf.get(id) as string))]
    return {
      query,
      email: firstOf(rankEmails(scored), query.relevant),
      everyEmail: firstOf(rankEveryEmail(scored), query.relevant),
      thread: firstOf(rankThreads(scored), threads),
    }
  })
  const by = (split: Query["split"]) => {
    const own = ranks.filter((r) => r.query.split === split)
    return {
      email: scoresOf(own.map((r) => r.email)),
      everyEmail: scoresOf(own.map((r) => r.everyEmail)),
      thread: scoresOf(own.map((r) => r.thread)),
      emailHitsAt5: own.filter((r) => r.email !== null && r.email < 5).length,
      everyEmailHitsAt5: own.filter((r) => r.everyEmail !== null && r.everyEmail < 5).length,
    }
  }
  results.push({
    variant,
    pieces: unique.length,
    chars: unique.reduce((sum, p) => sum + p.text.length, 0),
    overModelLimit: cut.length,
    vectorBytes: unique.length * model.dims * 4,
    dev: by("dev"),
    test: by("test"),
    ranks: ranks.map((r) => ({ query: r.query.id, email: r.email, everyEmail: r.everyEmail, thread: r.thread })),
  })
}
await embedder.close()

console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model, threads: cpus().length, ramGiB: totalmem() / 2 ** 30, os: `${platform()} ${release()}` },
      node: process.version,
      model: model.id,
      corpusSha256: createHash("sha256").update(corpusText).digest("hex"),
      corpus: {
        threads: corpus.threads.length,
        emails: threadOf.size,
        queries: { dev: corpus.queries.filter((q) => q.split === "dev").length, test: corpus.queries.filter((q) => q.split === "test").length },
      },
      throughput: { chars: embeddedChars, ms: Math.round(embeddingMs), charsPerSecond: Math.round(embeddedChars / (embeddingMs / 1000)) },
      results,
    },
    null,
    2,
  ),
)
