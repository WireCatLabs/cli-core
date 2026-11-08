import { CliError, type KeyringStore } from "@wirecat/cli-base"
import * as v from "valibot"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { type ModelAdapter, type ModelUsage, modelGateway } from "../models/index.js"
import type { AppIdentity } from "../ports/app.js"
import type { EnrichmentCandidate, EnrichmentNarrowing, EnrichmentStore, SavedEnrichment } from "../store/store.js"
import {
  costOf,
  type EnrichmentSetting,
  enrichmentEndpoint,
  estimateEnrichment,
  readEnrichmentSetting,
} from "./enrichment-setting.js"

/** One sync's share, as embedding is bounded per run; the next sync goes on where it stopped. */
export const ENRICH_PER_RUN = 600
const BATCH = 20
const CONCURRENCY = 4
/** A long document is enriched by its start: the cost stays bounded, and its own chunks carry the rest. */
const MAX_INPUT_CHARS = 4_000
const MAX_FACTS = 5
const MAX_QUESTIONS = 3
const MAX_LINE = 400
/** After this many failed batches in one run the provider is not answering; the rest wait for the next sync. */
const MAX_FAILED_BATCHES = 3

const SYSTEM = `For each record, write what a memory system would store about it.

For each record:
- facts: one to three standalone sentences, each stating exactly one fact. Name people, projects and things in
  full, leave no pronoun unresolved, and turn relative dates into absolute ones using the record's date. Keep
  amounts, dates and times exactly. Say whether the fact is confirmed, only proposed, rejected or cancelled.
  Small talk with no fact gets an empty list.
- questions: two questions a person might ask whose answer is in this record, in everyday words that differ
  from the record's own words (synonyms, plainer terms). Empty for small talk.

Write in the record's own language. Reply with JSON only: {"records": [{"i": <index>, "facts": [...], "questions": [...]}]}, one entry per record.`

const line = v.pipe(
  v.unknown(),
  v.transform((value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_LINE) : "")),
)
const Reply = v.object({
  records: v.array(
    v.object({
      i: v.pipe(v.number(), v.integer(), v.minValue(0)),
      facts: v.optional(v.array(line), []),
      questions: v.optional(v.array(line), []),
    }),
  ),
})

/** The reply's rows by index; a reply that is not this JSON fails the whole batch. */
export const parseEnrichmentReply = (text: string): Map<number, string> => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end < start) throw new CliError("invalid_response", "the enrichment reply holds no JSON object")
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new CliError("invalid_response", "the enrichment reply is not valid JSON")
  }
  const checked = v.safeParse(Reply, parsed)
  if (!checked.success) throw new CliError("invalid_response", "the enrichment reply does not have the asked shape")
  return new Map(
    checked.output.records.map((row) => [
      row.i,
      [...row.facts.slice(0, MAX_FACTS), ...row.questions.slice(0, MAX_QUESTIONS)].filter(Boolean).join("\n"),
    ]),
  )
}

export interface EnrichOptions {
  env: NodeJS.ProcessEnv
  /** The tool whose keyring entry holds the provider key; without it only the environment's key is read. */
  app?: AppIdentity
  keyring?: KeyringStore
  maxRecords?: number
  concurrency?: number
  narrow?: EnrichmentNarrowing
  /** Tests inject these; nothing in the suite reaches a provider. */
  adapters?: Readonly<Record<string, ModelAdapter>>
  fetch?: typeof fetch
  key?: (provider: string) => string | undefined
  signal?: AbortSignal
}

export type EnrichRun =
  | { status: "off" }
  | {
      status: "done" | "stopped"
      provider: string
      model: string
      /** Records the model answered for, with or without facts. */
      enriched: number
      failed: number
      /** Records still without an enrichment of their current text, in the types this run read. */
      left: number
      usage: ModelUsage
      cost_usd: number | null
      /** Why a stopped run stopped, with no provider body or key in it. */
      reason?: string
    }

const recordsData = (batch: readonly EnrichmentCandidate[]) =>
  JSON.stringify(
    batch.map((record, i) => ({
      i,
      date: record.at === null ? null : new Date(record.at).toISOString().slice(0, 10),
      kind: record.type === "email" ? "mail" : "note",
      text: record.text.slice(0, MAX_INPUT_CHARS),
    })),
  )

const keyReader = (options: EnrichOptions, setting: EnrichmentSetting) => {
  if (options.key) return () => options.key?.(setting.provider)
  const name = setting.base_url === undefined ? setting.provider : endpointKeyName(setting.base_url)
  if (options.app) return () => embeddingKeys(options.app as AppIdentity, options.env, options.keyring).read(name)?.key
  const variable = `${setting.provider.toUpperCase()}_API_KEY`
  return () => (setting.base_url === undefined ? options.env[variable]?.trim() || undefined : undefined)
}

/**
 * Sends records with no enrichment of their current text to the provider the owner consented to, in batches, and
 * keeps what it writes; the next index drain puts it beside each record. Off, it sends nothing and reads no key.
 */
export const enrichRecords = async (
  store: { enrichment?: EnrichmentStore | undefined },
  options: EnrichOptions,
): Promise<EnrichRun> => {
  const setting = readEnrichmentSetting(options.env)
  if (!setting || !store.enrichment) return { status: "off" }
  const enrichment = store.enrichment
  const baseUrl = enrichmentEndpoint(setting)
  const target = { provider: setting.provider, model: setting.model, baseUrl }
  const key = keyReader(options, setting)
  const gateway = modelGateway({
    resolve: () => target,
    // The setting exists only with the owner's yes for this provider and endpoint; the endpoint is checked again.
    consent: (_request, chosen) => chosen.provider === setting.provider && chosen.baseUrl === baseUrl,
    key: () => key(),
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const maxRecords = options.maxRecords ?? ENRICH_PER_RUN
  const queue = await enrichment.pending(maxRecords, options.narrow)
  const batches: EnrichmentCandidate[][] = []
  for (let start = 0; start < queue.length; start += BATCH) batches.push(queue.slice(start, start + BATCH))
  const usage: ModelUsage = { input: 0, output: 0 }
  let enriched = 0
  let failed = 0
  let failedBatches = 0
  let reason: string | undefined
  const ask = async (batch: EnrichmentCandidate[]) => {
    const answer = await gateway.complete({
      purpose: "enrichment",
      system: SYSTEM,
      prompt: "Enrich each record of the data.",
      data: recordsData(batch),
      // The facts must keep names, amounts and dates exactly, which the default no-copy policy forbids.
      allowSourceQuotes: true,
      maxTokens: 8_192,
      ...(setting.provider === "openai" && setting.base_url === undefined
        ? { options: { response_format: { type: "json_object" }, temperature: 0 } }
        : {}),
    })
    const rows = parseEnrichmentReply(answer.text)
    const used = answer.usage ?? { input: answer.tokens, output: 0 }
    usage.input += used.input
    usage.output += used.output
    const answered = batch.flatMap((record, i): SavedEnrichment[] => {
      const text = rows.get(i)
      return text === undefined
        ? []
        : [
            {
              type: record.type,
              id: record.id,
              hash: record.hash,
              provider: setting.provider,
              model: setting.model,
              text,
              tokens: Math.round(answer.tokens / batch.length),
            },
          ]
    })
    await enrichment.save(answered)
    enriched += answered.length
    failed += batch.length - answered.length
  }
  let next = 0
  const worker = async () => {
    while (reason === undefined && next < batches.length) {
      const batch = batches[next++] as EnrichmentCandidate[]
      try {
        await ask(batch)
      } catch (error) {
        failed += batch.length
        const code = error instanceof CliError ? error.code : "invalid_response"
        if (code !== "invalid_response" || ++failedBatches >= MAX_FAILED_BATCHES)
          reason = error instanceof CliError ? error.message : "the enrichment provider failed"
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, batches.length) }, () => worker()),
  )
  const left = (await enrichment.pending(Number.MAX_SAFE_INTEGER, options.narrow)).length
  return {
    status: reason === undefined ? "done" : "stopped",
    provider: setting.provider,
    model: setting.model,
    enriched,
    failed,
    left,
    usage,
    cost_usd: costOf(usage, setting),
    ...(reason === undefined ? {} : { reason }),
  }
}

export interface EnrichmentState {
  on: boolean
  provider: string | null
  model: string | null
  endpoint: string | null
  consented_at: string | null
  records: number
  enriched: number
  pending: number
  /** What enriching the pending records would cost with the chosen model, or with `estimateFor` when given. */
  estimate: ReturnType<typeof estimateEnrichment>
}

/** The setting and how far the store is enriched: what a window shows beside the switch. */
export const enrichmentState = async (
  store: { enrichment?: EnrichmentStore | undefined },
  env: NodeJS.ProcessEnv,
  estimateFor?: Pick<EnrichmentSetting, "provider" | "model" | "base_url">,
): Promise<EnrichmentState> => {
  const setting = readEnrichmentSetting(env)
  const counts = (await store.enrichment?.counts()) ?? { records: 0, enriched: 0, pendingChars: 0 }
  const pending = counts.records - counts.enriched
  return {
    on: setting !== undefined,
    provider: setting?.provider ?? null,
    model: setting?.model ?? null,
    endpoint: setting ? enrichmentEndpoint(setting) : null,
    consented_at: setting?.consented_at ?? null,
    records: counts.records,
    enriched: counts.enriched,
    pending,
    estimate: estimateEnrichment(pending, counts.pendingChars, estimateFor ?? setting),
  }
}
