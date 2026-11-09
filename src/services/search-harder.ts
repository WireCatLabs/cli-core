import { CliError, type KeyringStore } from "@wirecat/cli-base"
import * as v from "valibot"
import { type ModelAdapter, modelGateway } from "../models/index.js"
import type { AppIdentity } from "../ports/app.js"
import { readSharedSection, writeSharedSection } from "../store/shared-config.js"
import { keyLookup, keyVariable } from "./enrichment.js"
import { costOf, enrichmentSettingPath } from "./enrichment-setting.js"

const SECTION = "search_harder"
export const HARDER_PROVIDER = "anthropic"
export const DEFAULT_HARDER_MODEL = "claude-haiku-5-5"
export const HARDER_ENDPOINT = "https://api.anthropic.com"
/** The search lab's setup (cli-testing search-lab, "Haiku rerank"): the top 30, each cut to 400 characters. */
export const HARDER_CANDIDATES = 30
export const HARDER_CHARS = 400
const TIMEOUT_MS = 5_000

const Setting = v.strictObject({
  provider: v.literal(HARDER_PROVIDER),
  model: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
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

const recordLine = (hit: HarderHit, i: number) =>
  `[${i}] (${hit.timestamp?.slice(0, 10) ?? "undated"}) ${`${hit.title ? `${hit.title}\n` : ""}${hit.text.slice(0, HARDER_CHARS)}`.replace(/\s*\n\s*/g, " ")}`

const REASON_TEXT: Record<HarderReasonId, string> = {
  "harder.no-consent": "the owner has not agreed to send searches to a hosted model",
  "harder.no-key": "no Anthropic key",
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

/**
 * `search all --harder`: a hosted model reads the question with the first 30 hits and puts the ones that answer it
 * first. Any failure keeps the plain order and says why; it never fails the search. Without the owner's consent or a
 * key nothing is sent.
 */
export const reorderHarder = async <T extends HarderHit>(
  question: string,
  hits: readonly T[],
  {
    env,
    now,
    command,
    laterPage,
    ...options
  }: HarderOptions & { env: NodeJS.ProcessEnv; now: number; command?: string; laterPage?: boolean },
): Promise<{ items: T[]; harder: HarderResult }> => {
  const started = Date.now()
  const setting = readHarderSetting(env)
  const model = setting?.model ?? DEFAULT_HARDER_MODEL
  const plain = (reason_id: HarderReasonId, extra: Partial<HarderResult> = {}, reason = REASON_TEXT[reason_id]) => ({
    items: [...hits],
    harder: {
      applied: false,
      provider: HARDER_PROVIDER,
      model,
      sent: 0,
      cost_usd: 0,
      ms: Date.now() - started,
      ...extra,
      reason,
      reason_id,
    },
  })
  if (laterPage) return plain("harder.later-page")
  const tool = command ?? "memo"
  if (!setting)
    return plain(
      "harder.no-consent",
      {},
      `${REASON_TEXT["harder.no-consent"]}: \`${tool} models search-consents set anthropic --yes\`; nothing was sent`,
    )
  const apiKey = keyLookup({ env, ...options }, { provider: HARDER_PROVIDER })?.key
  if (apiKey === undefined)
    return plain(
      "harder.no-key",
      {},
      `no Anthropic key: \`${tool} models keys set anthropic\` or set ${keyVariable(HARDER_PROVIDER)}; nothing was sent`,
    )
  const candidates = hits.slice(0, HARDER_CANDIDATES)
  if (candidates.length < 2) return plain("harder.too-few")
  const limit = new AbortController()
  const timer = setTimeout(() => limit.abort(), options.timeoutMs ?? TIMEOUT_MS)
  const gateway = modelGateway({
    resolve: () => ({ provider: HARDER_PROVIDER, model: setting.model, baseUrl: HARDER_ENDPOINT }),
    consent: (_request, chosen) => chosen.provider === HARDER_PROVIDER && chosen.baseUrl === HARDER_ENDPOINT,
    key: () => apiKey,
    signal: limit.signal,
    ...(options.adapters ? { adapters: options.adapters } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const sent = { sent: candidates.length }
  try {
    const answer = await gateway.complete({
      purpose: "search-harder",
      prompt: PROMPT.replace("{as_of}", new Date(now).toISOString().slice(0, 10))
        .replace("{n}", String(candidates.length))
        .replace("{question}", question),
      data: candidates.map(recordLine).join("\n"),
      maxTokens: 300,
      options: { thinking: { type: "disabled" }, output_config: { effort: "low", format: FORMAT } },
    })
    const cost = costOf(answer.usage ?? { input: answer.tokens, output: 0 }, {
      provider: HARDER_PROVIDER,
      model: setting.model,
    })
    let picked: number[]
    try {
      picked = v.parse(Reply, JSON.parse(answer.text)).records
    } catch {
      return plain("harder.bad-reply", { ...sent, cost_usd: cost })
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
        provider: HARDER_PROVIDER,
        model: setting.model,
        ...sent,
        cost_usd: cost,
        ms: Date.now() - started,
      },
    }
  } catch (error) {
    return plain(reasonOf(error, limit.signal.aborted), { ...sent, cost_usd: null })
  } finally {
    clearTimeout(timer)
  }
}
