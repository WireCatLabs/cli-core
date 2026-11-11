import { CliError, type KeyringStore } from "@wirecat/cli-base"
import * as v from "valibot"
import { embeddingKeys, endpointKeyName } from "../embeddings/keys.js"
import { modelAddressAllowed, onThisComputer } from "../models/endpoint.js"
import { type ModelAdapter, type ModelUsage, modelGateway } from "../models/index.js"
import { localOnly } from "../models/local-only.js"
import type { AppIdentity } from "../ports/app.js"
import type { EnrichmentCandidate, EnrichmentNarrowing, EnrichmentStore, SavedEnrichment } from "../store/store.js"
import {
  costOf,
  DEFAULT_OFFER,
  type EnrichmentSetting,
  enrichmentEndpoint,
  enrichmentPrice,
  estimateEnrichment,
  offeredModels,
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

/** Why a run stopped or failed, from a fixed list, so a window can say it in its own words. */
export const ENRICHMENT_REASON_IDS = [
  "enrichment.no-key",
  "enrichment.key-rejected",
  "enrichment.unreachable",
  "enrichment.rate-limited",
  "enrichment.bad-replies",
  "enrichment.cancelled",
  "enrichment.local-only",
  "enrichment.address-refused",
  "enrichment.error",
] as const
export type EnrichmentReasonId = (typeof ENRICHMENT_REASON_IDS)[number]

const REASON_TEXT: Partial<Record<EnrichmentReasonId, string>> = {
  "enrichment.key-rejected": "the provider refused the key; nothing more was sent",
  "enrichment.unreachable": "the provider could not be reached; nothing more was sent",
}

const reasonIdOf = (error: unknown): EnrichmentReasonId => {
  // A reply that cannot be read throws a plain error: one more bad batch.
  if (!(error instanceof CliError)) return "enrichment.bad-replies"
  if (error.details.reason === "model.key-rejected") return "enrichment.key-rejected"
  if (error.details.reason === "model.unreachable") return "enrichment.unreachable"
  if (error.details.reason === "local-only.refused") return "enrichment.local-only"
  if (error.code === "rate_limited") return "enrichment.rate-limited"
  if (error.code === "cancelled") return "enrichment.cancelled"
  if (error.code === "invalid_response") return "enrichment.bad-replies"
  return "enrichment.error"
}

export type EnrichRun =
  | { status: "off" }
  | {
      /** `failed`: records were sent and none came back enriched. */
      status: "done" | "stopped" | "failed"
      provider: string
      model: string
      /** Records the model answered for, with or without facts. */
      enriched: number
      failed: number
      /** Records still without an enrichment of their current text, in the types this run read. */
      left: number
      usage: ModelUsage
      cost_usd: number | null
      /** Why a stopped or failed run ended, with no provider body or key in it. */
      reason?: string
      reason_id?: EnrichmentReasonId
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

export type KeySource = "keyring" | "file" | "env" | "given"

/** The provider's key and where it came from; it never leaves this process. */
export const keyLookup = (
  options: Pick<EnrichOptions, "env" | "app" | "keyring" | "key">,
  setting: Pick<EnrichmentSetting, "provider" | "base_url">,
): { key: string; source: KeySource } | undefined => {
  if (options.key) {
    const key = options.key(setting.provider)
    return key === undefined ? undefined : { key, source: "given" }
  }
  const name = setting.base_url === undefined ? setting.provider : endpointKeyName(setting.base_url)
  if (options.app) {
    const keys = embeddingKeys(options.app, options.env, options.keyring)
    // The tool's `embeddings:<provider>` entry or the environment, then an entry named after the provider alone.
    const stored = keys.read(name)
    if (stored)
      return {
        key: stored.key,
        source: stored.source === "file" ? "file" : stored.source === "keyring" ? "keyring" : "env",
      }
    const plain = setting.base_url === undefined ? keys.readPlain(setting.provider) : undefined
    return plain === undefined ? undefined : { key: plain, source: "keyring" }
  }
  const key = setting.base_url === undefined ? options.env[keyVariable(setting.provider)]?.trim() : undefined
  return key ? { key, source: "env" } : undefined
}

export const keyVariable = (provider: string): string => `${provider.toUpperCase()}_API_KEY`

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
  const apiKey = keyLookup(options, setting)?.key
  const maxRecords = options.maxRecords ?? ENRICH_PER_RUN
  const refused: EnrichmentReasonId | undefined = !modelAddressAllowed(baseUrl)
    ? "enrichment.address-refused"
    : !onThisComputer(baseUrl) && localOnly(options.env)
      ? "enrichment.local-only"
      : undefined
  if (refused)
    return {
      status: "stopped",
      provider: setting.provider,
      model: setting.model,
      enriched: 0,
      failed: 0,
      left: (await enrichment.pending(Number.MAX_SAFE_INTEGER, options.narrow)).length,
      usage: { input: 0, output: 0 },
      cost_usd: 0,
      reason:
        refused === "enrichment.local-only"
          ? "local only is on and the model is not on this computer; nothing was sent"
          : "the address is plain http to another computer: use https, or http only on this computer; nothing was sent",
      reason_id: refused,
    }
  // Without a key the public API answers 401 only after the records' text has left; a custom server may need none.
  if (apiKey === undefined && setting.base_url === undefined)
    return {
      status: "stopped",
      provider: setting.provider,
      model: setting.model,
      enriched: 0,
      failed: 0,
      left: (await enrichment.pending(Number.MAX_SAFE_INTEGER, options.narrow)).length,
      usage: { input: 0, output: 0 },
      cost_usd: 0,
      reason: `no ${setting.provider} key: store one with \`models keys set ${setting.provider}\` or set ${keyVariable(setting.provider)}; nothing was sent`,
      reason_id: "enrichment.no-key",
    }
  const gateway = modelGateway({
    resolve: () => target,
    // The setting exists only with the owner's yes for this provider and endpoint; the endpoint is checked again.
    consent: (_request, chosen) => chosen.provider === setting.provider && chosen.baseUrl === baseUrl,
    key: () => apiKey,
    env: options.env,
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const queue = await enrichment.pending(maxRecords, options.narrow)
  const batches: EnrichmentCandidate[][] = []
  for (let start = 0; start < queue.length; start += BATCH) batches.push(queue.slice(start, start + BATCH))
  const usage: ModelUsage = { input: 0, output: 0 }
  let enriched = 0
  let failed = 0
  let failedBatches = 0
  let reason: string | undefined
  let reasonId: EnrichmentReasonId | undefined
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
        const id = reasonIdOf(error)
        // A refused key or an unreachable provider fails every batch the same way; only a bad reply may be one-off.
        if (id !== "enrichment.bad-replies" || ++failedBatches >= MAX_FAILED_BATCHES) {
          reason = REASON_TEXT[id] ?? (error instanceof CliError ? error.message : "the enrichment provider failed")
          reasonId = id
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, batches.length) }, () => worker()),
  )
  const left = (await enrichment.pending(Number.MAX_SAFE_INTEGER, options.narrow)).length
  const none = enriched === 0 && failed > 0
  if (none && reason === undefined) {
    reason = `the provider enriched none of the ${failed} records sent; they are sent again next sync`
    reasonId = "enrichment.bad-replies"
  }
  return {
    status: none ? "failed" : reason === undefined ? "done" : "stopped",
    provider: setting.provider,
    model: setting.model,
    enriched,
    failed,
    left,
    usage,
    cost_usd: costOf(usage, setting),
    ...(reason === undefined ? {} : { reason }),
    ...(reasonId === undefined ? {} : { reason_id: reasonId }),
  }
}

export interface EnrichmentTarget {
  provider: string
  model: string
  endpoint: string
  endpoint_host: string
  /** Whether a key for this provider is found, and where; never the key. */
  key: { present: boolean; source: KeySource | null; env_var: string }
  price_known: boolean
}

export interface EnrichmentState {
  on: boolean
  /** The setting in force; `null` while off. */
  provider: string | null
  model: string | null
  endpoint: string | null
  consented_at: string | null
  /**
   * What the estimate and the consent are about: the setting in force, else the one `set` proposes, else the
   * default offer. A window shows its price while enrichment is off.
   */
  target: EnrichmentTarget
  records: number
  enriched: number
  pending: number
  estimate: ReturnType<typeof estimateEnrichment>
  /** Records one sync enriches of notes and documents, and as many of mail. */
  per_sync: number
  /** Syncs to enrich what is pending now. */
  syncs_needed: number
  /** Every record added or changed later is sent too, at the next sync. */
  sends_new_records: true
  offered: readonly {
    provider: string
    model: string
    default: boolean
    usd_per_million: { input: number; output: number }
  }[]
  /** What the measurement on synthetic data found; the consent text quotes it. */
  measured: typeof MEASURED
}

/** cli-testing write-time-enrichment, 10,444 synthetic records, memo with e5-small, gpt-4o-mini, 2026-11-08. */
export const MEASURED = {
  reworded_at_10: { off: 0.62, on: 0.79 },
  own_words_first: { off: 0.54, on: 0.48 },
  source: "https://github.com/WireCatLabs/cli-testing/pull/322",
} as const

/** The setting and how far the store is enriched: what a window shows beside the switch. */
export const enrichmentState = async (
  store: { enrichment?: EnrichmentStore | undefined },
  env: NodeJS.ProcessEnv,
  estimateFor?: Pick<EnrichmentSetting, "provider" | "model" | "base_url">,
  keys: Pick<EnrichOptions, "app" | "keyring"> = {},
): Promise<EnrichmentState> => {
  const setting = readEnrichmentSetting(env)
  const counts = (await store.enrichment?.counts()) ?? {
    records: 0,
    enriched: 0,
    pendingChars: 0,
    pendingByType: { document: 0, note: 0, email: 0 },
  }
  const pending = counts.records - counts.enriched
  const chosen: Pick<EnrichmentSetting, "provider" | "model" | "base_url"> = estimateFor ?? setting ?? DEFAULT_OFFER
  const endpoint = enrichmentEndpoint(chosen)
  const found = keyLookup({ env, ...keys }, chosen)
  const notes = counts.pendingByType.document + counts.pendingByType.note
  return {
    on: setting !== undefined,
    provider: setting?.provider ?? null,
    model: setting?.model ?? null,
    endpoint: setting ? enrichmentEndpoint(setting) : null,
    consented_at: setting?.consented_at ?? null,
    target: {
      provider: chosen.provider,
      model: chosen.model,
      endpoint,
      endpoint_host: new URL(endpoint).host,
      key: { present: found !== undefined, source: found?.source ?? null, env_var: keyVariable(chosen.provider) },
      price_known: enrichmentPrice(chosen.provider, chosen.model, chosen.base_url) !== undefined,
    },
    records: counts.records,
    enriched: counts.enriched,
    pending,
    estimate: estimateEnrichment(pending, counts.pendingChars, chosen),
    per_sync: ENRICH_PER_RUN,
    syncs_needed: Math.ceil(Math.max(notes, counts.pendingByType.email) / ENRICH_PER_RUN),
    sends_new_records: true,
    offered: offeredModels(),
    measured: MEASURED,
  }
}
