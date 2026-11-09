import { CliError, type KeyringStore } from "@wirecat/cli-base"
import * as v from "valibot"
import { type ModelAdapter, type ModelRequest, modelGateway } from "../models/index.js"
import type { AppIdentity } from "../ports/app.js"
import { readSharedSection, writeSharedSection } from "../store/shared-config.js"
import { keyLookup, keyVariable } from "./enrichment.js"
import {
  costOf,
  type EnrichmentProvider,
  enrichmentEndpoint,
  enrichmentSettingPath,
  MODEL_CHOICE,
} from "./enrichment-setting.js"

const SECTION = "search_harder"
/**
 * Each provider's model when the owner names none: small and fast for a short answer. gpt-4o-mini, not a cheaper
 * reasoning model, because the OpenAI adapter cannot turn reasoning down (pricing read 2026-11-09).
 */
export const HARDER_MODELS: Readonly<Record<EnrichmentProvider, string>> = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-4o-mini",
}
/** The search lab's setup (cli-testing search-lab, "Haiku rerank"): the top 30, each cut to 400 characters. */
export const HARDER_CANDIDATES = 30
export const HARDER_CHARS = 400
const TIMEOUT_MS = 5_000

const Setting = v.strictObject({
  ...MODEL_CHOICE,
  /** When the owner agreed that a `--harder` search sends its question and hits; the setting exists only with it. */
  consented_at: v.pipe(v.string(), v.isoTimestamp()),
})

export type HarderSetting = v.InferOutput<typeof Setting>

/** The owner's consent, or `undefined`: no section means `--harder` sends nothing. */
export const readHarderSetting = (env: NodeJS.ProcessEnv): HarderSetting | undefined => {
  const path = enrichmentSettingPath(env)
  const section = readSharedSection(path, SECTION)
  if (section === undefined || section === null) return undefined
  const checked = v.safeParse(Setting, section)
  if (!checked.success)
    throw new CliError(
      "configuration_error",
      `${path}: ${SECTION}.${v.getDotPath(checked.issues[0]) ?? "settings"} is invalid — ${checked.issues[0].message}`,
    )
  return checked.output
}

export const writeHarderSetting = (env: NodeJS.ProcessEnv, setting: HarderSetting | undefined): void =>
  writeSharedSection(enrichmentSettingPath(env), SECTION, setting === undefined ? undefined : v.parse(Setting, setting))

export const HARDER_REASON_IDS = [
  "harder.no-consent",
  "harder.no-key",
  "harder.bad-setting",
  "harder.later-page",
  "harder.too-few",
  "harder.timeout",
  "harder.key-rejected",
  "harder.unreachable",
  "harder.rate-limited",
  "harder.bad-reply",
  "harder.error",
] as const
export type HarderReasonId = (typeof HARDER_REASON_IDS)[number]

/** What `--harder` did: `applied` only when the model's order replaced the plain one. */
export interface HarderResult {
  applied: boolean
  provider: string
  model: string
  /** The API the question went to, or would have. */
  endpoint: string
  /** Hits sent to the model; 0 when nothing left this machine. */
  sent: number
  cost_usd: number | null
  ms: number
  reason?: string
  reason_id?: HarderReasonId
}

export interface HarderOptions {
  /** The tool whose keyring entry holds the key; without it only the environment's key is read. */
  app?: AppIdentity
  keyring?: KeyringStore
  /** Tests inject these; nothing in the suite reaches a provider. */
  adapters?: Readonly<Record<string, ModelAdapter>>
  fetch?: typeof fetch
  key?: (provider: string) => string | undefined
  timeoutMs?: number
}

export interface HarderHit {
  title: string | null
  timestamp: string | null
  text: string
}

// The search lab's prompt, word for word, except that the records travel as the gateway's untrusted data.
const PROMPT =
  "Today is {as_of}. A person searches their own archive of messages, mails, notes, calendar entries and phone " +
  "records with the question below. Here are {n} candidate records, numbered, in the data.\n\n" +
  "Question: {question}\n\n" +
  "Which records help answer the question? List their numbers, most useful first, at most ten; an empty list if " +
  "none does."

// Only Anthropic takes the schema; another provider is told the shape, and its answer is read leniently.
const JSON_SHAPE = '\n\nAnswer with JSON only, in the form {"records": [numbers]}.'

const FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: { records: { type: "array", items: { type: "integer" } } },
    required: ["records"],
    additionalProperties: false,
  },
} as const

const Reply = v.object({ records: v.array(v.pipe(v.number(), v.integer())) })

/** The JSON in an answer, also when a model wraps it in a code block or a sentence. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start < 0 || end <= start) throw new Error("no JSON in the answer")
    return JSON.parse(text.slice(start, end + 1))
  }
}

const recordLine = (hit: HarderHit, i: number) =>
  `[${i}] (${hit.timestamp?.slice(0, 10) ?? "undated"}) ${`${hit.title ? `${hit.title}\n` : ""}${hit.text.slice(0, HARDER_CHARS)}`.replace(/\s*\n\s*/g, " ")}`

const REASON_TEXT: Record<HarderReasonId, string> = {
  "harder.no-consent": "the owner has not agreed to send searches to a hosted model",
  "harder.no-key": "no key for the provider",
  "harder.bad-setting": "the search_harder setting cannot be read; nothing was sent",
  "harder.later-page": "--harder reorders the first page only; nothing was sent",
  "harder.too-few": "fewer than two hits to reorder; nothing was sent",
  "harder.timeout": `the model did not answer within ${TIMEOUT_MS / 1000} s`,
  "harder.key-rejected": "the provider refused the key",
  "harder.unreachable": "the provider could not be reached",
  "harder.rate-limited": "the provider's rate limit was reached",
  "harder.bad-reply": "the model's answer could not be read",
  "harder.error": "the provider failed",
}

const reasonOf = (error: unknown, timedOut: boolean): HarderReasonId => {
  if (timedOut) return "harder.timeout"
  if (!(error instanceof CliError)) return "harder.bad-reply"
  if (error.details.reason === "model.key-rejected") return "harder.key-rejected"
  if (error.details.reason === "model.unreachable") return "harder.unreachable"
  if (error.code === "rate_limited") return "harder.rate-limited"
  return "harder.error"
}

type Asking = HarderOptions & { env: NodeJS.ProcessEnv; now: number; command?: string }

/** The consent and key a call needs, or why nothing may be sent. */
export type HarderAccess =
  | { ready: true; provider: EnrichmentProvider; model: string; endpoint: string; custom: boolean; key?: string }
  | { ready: false; provider: string; model: string; endpoint: string; reason_id: HarderReasonId; reason: string }

const UNSET = {
  provider: "anthropic",
  model: HARDER_MODELS.anthropic,
  endpoint: enrichmentEndpoint({ provider: "anthropic" }),
} as const

export const harderAccess = ({ env, command, ...options }: Asking): HarderAccess => {
  let setting: HarderSetting | undefined
  try {
    setting = readHarderSetting(env)
  } catch (error) {
    const unreadable = error instanceof CliError ? error.message : REASON_TEXT["harder.bad-setting"]
    return { ready: false, ...UNSET, reason_id: "harder.bad-setting", reason: `${unreadable}; nothing was sent` }
  }
  const tool = command ?? "memo"
  if (!setting)
    return {
      ready: false,
      ...UNSET,
      reason_id: "harder.no-consent",
      reason: `${REASON_TEXT["harder.no-consent"]}: \`${tool} models search-consents set <provider> --yes\`; nothing was sent`,
    }
  const chosen = {
    provider: setting.provider,
    model: setting.model,
    endpoint: enrichmentEndpoint(setting),
    custom: setting.base_url !== undefined,
  }
  let key: string | undefined
  try {
    key = keyLookup({ env, ...options }, setting)?.key
  } catch {
    return {
      ready: false,
      ...chosen,
      reason_id: "harder.error",
      reason: `the ${setting.provider} key could not be read; nothing was sent`,
    }
  }
  // A server of the owner's own may need no key; the public API would answer 401 only after the question left.
  if (key === undefined && !chosen.custom)
    return {
      ready: false,
      ...chosen,
      reason_id: "harder.no-key",
      reason: `no ${setting.provider} key: \`${tool} models keys set ${setting.provider}\` or set ${keyVariable(setting.provider)}; nothing was sent`,
    }
  return { ready: true, ...chosen, ...(key === undefined ? {} : { key }) }
}

/** One call to the model under the 5 s limit; a failure comes back as its reason, never thrown. */
const ask = async (
  access: Extract<HarderAccess, { ready: true }>,
  options: HarderOptions,
  request: Omit<ModelRequest, "options"> & { format?: typeof FORMAT },
): Promise<{ text: string; cost: number | null } | { reason_id: HarderReasonId }> => {
  const limit = new AbortController()
  const timer = setTimeout(() => limit.abort(), options.timeoutMs ?? TIMEOUT_MS)
  const gateway = modelGateway({
    resolve: () => ({ provider: access.provider, model: access.model, baseUrl: access.endpoint }),
    consent: (_request, chosen) => chosen.provider === access.provider && chosen.baseUrl === access.endpoint,
    key: () => access.key,
    signal: limit.signal,
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const { format, ...rest } = request
  // Each adapter refuses options it does not know, so Anthropic's never reach another provider.
  const settings =
    access.provider === "anthropic"
      ? { thinking: { type: "disabled" }, output_config: { effort: "low", ...(format ? { format } : {}) } }
      : access.custom
        ? undefined
        : { temperature: 0, ...(format ? { response_format: { type: "json_object" } } : {}) }
  try {
    const answer = await gateway.complete({
      ...rest,
      ...(format && access.provider !== "anthropic" ? { prompt: `${rest.prompt}${JSON_SHAPE}` } : {}),
      ...(settings ? { options: settings } : {}),
    })
    const cost = costOf(answer.usage ?? { input: answer.tokens, output: 0 }, {
      provider: access.provider,
      model: access.model,
      ...(access.custom ? { base_url: access.endpoint } : {}),
    })
    return { text: answer.text, cost }
  } catch (error) {
    return { reason_id: reasonOf(error, limit.signal.aborted) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `search all --harder`: a hosted model reads the question with the first 30 hits and puts the ones that answer it
 * first. Any failure keeps the plain order and says why; it never fails the search. Without the owner's consent or a
 * key nothing is sent.
 */
export const reorderHarder = async <T extends HarderHit>(
  question: string,
  hits: readonly T[],
  { laterPage, access: given, ...asking }: Asking & { laterPage?: boolean; access?: HarderAccess },
): Promise<{ items: T[]; harder: HarderResult }> => {
  const started = Date.now()
  const access = laterPage ? undefined : (given ?? harderAccess(asking))
  const plain = (reason_id: HarderReasonId, extra: Partial<HarderResult> = {}, reason = REASON_TEXT[reason_id]) => ({
    items: [...hits],
    harder: {
      applied: false,
      provider: (access ?? UNSET).provider,
      model: (access ?? UNSET).model,
      endpoint: (access ?? UNSET).endpoint,
      sent: 0,
      cost_usd: 0,
      ms: Date.now() - started,
      ...extra,
      reason,
      reason_id,
    },
  })
  if (!access) return plain("harder.later-page")
  if (!access.ready) return plain(access.reason_id, {}, access.reason)
  const candidates = hits.slice(0, HARDER_CANDIDATES)
  if (candidates.length < 2) return plain("harder.too-few")
  const sent = { sent: candidates.length }
  const answer = await ask(access, asking, {
    purpose: "search-harder",
    prompt: PROMPT.replace("{as_of}", new Date(asking.now).toISOString().slice(0, 10))
      .replace("{n}", String(candidates.length))
      .replace("{question}", () => question),
    data: candidates.map(recordLine).join("\n"),
    maxTokens: 300,
    format: FORMAT,
  })
  if ("reason_id" in answer) return plain(answer.reason_id, { ...sent, cost_usd: null })
  let picked: number[]
  try {
    picked = v.parse(Reply, jsonOf(answer.text)).records
  } catch {
    return plain("harder.bad-reply", { ...sent, cost_usd: answer.cost })
  }
  const first = [...new Set(picked.filter((i) => i >= 0 && i < candidates.length))]
  const chosen = new Set(first)
  return {
    items: [
      ...first.map((i) => candidates[i] as T),
      ...candidates.filter((_, i) => !chosen.has(i)),
      ...hits.slice(HARDER_CANDIDATES),
    ],
    harder: {
      applied: true,
      provider: access.provider,
      model: access.model,
      endpoint: access.endpoint,
      ...sent,
      cost_usd: answer.cost,
      ms: Date.now() - started,
    },
  }
}
