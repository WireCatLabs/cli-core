import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { endpoint } from "../models/endpoint.js"
import { storePath } from "../store/path.js"
import { readSharedSection, sharedConfigPath, writeSharedSection } from "../store/shared-config.js"

const SECTION = "enrichment"

export const ENRICHMENT_PROVIDERS = ["openai", "anthropic"] as const
export type EnrichmentProvider = (typeof ENRICHMENT_PROVIDERS)[number]

const DEFAULT_BASE_URLS: Record<EnrichmentProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
}

const Setting = v.strictObject({
  provider: v.picklist(ENRICHMENT_PROVIDERS),
  model: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  base_url: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => endpoint(value), "use an HTTP/S endpoint without credentials, query or fragment"),
    ),
  ),
  /** When the owner agreed that records go to this provider and endpoint; the setting exists only with it. */
  consented_at: v.pipe(v.string(), v.isoTimestamp()),
})

export type EnrichmentSetting = v.InferOutput<typeof Setting>

export const enrichmentSettingPath = (env: NodeJS.ProcessEnv): string => sharedConfigPath(storePath(env), env)

/** The owner's choice, or `undefined` when enrichment is off: no section means off. */
export const readEnrichmentSetting = (env: NodeJS.ProcessEnv): EnrichmentSetting | undefined => {
  const path = enrichmentSettingPath(env)
  const section = readSharedSection(path, SECTION)
  if (section === undefined || section === null) return undefined
  const checked = v.safeParse(Setting, section)
  if (!checked.success)
    throw new CliError(
      "configuration_error",
      `${path}: enrichment.${v.getDotPath(checked.issues[0]) ?? "settings"} is invalid — ${checked.issues[0].message}`,
    )
  return checked.output
}

export const writeEnrichmentSetting = (env: NodeJS.ProcessEnv, setting: EnrichmentSetting | undefined): void =>
  writeSharedSection(enrichmentSettingPath(env), SECTION, setting === undefined ? undefined : v.parse(Setting, setting))

export const enrichmentEndpoint = (setting: Pick<EnrichmentSetting, "provider" | "base_url">): string =>
  setting.base_url ?? DEFAULT_BASE_URLS[setting.provider]

export const isEnrichmentProvider = (value: string): value is EnrichmentProvider =>
  (ENRICHMENT_PROVIDERS as readonly string[]).includes(value)

/** USD per token, from the providers' price pages on 2026-11-08; a model not listed gets no price. */
const PRICES: Record<string, { input: number; output: number; source: string }> = {
  "openai/gpt-4o-mini": {
    input: 0.15e-6,
    output: 0.6e-6,
    source: "https://developers.openai.com/api/docs/pricing",
  },
  "anthropic/claude-haiku-5-5": {
    input: 0.1e-6,
    output: 0.5e-6,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
  },
}

/** What `show` estimates while enrichment is off and nothing is proposed: the measured model. */
export const DEFAULT_OFFER = { provider: "openai", model: "gpt-4o-mini" } as const satisfies Pick<
  EnrichmentSetting,
  "provider" | "model"
>

/** The provider and model pairs offered, each with its price; another model is allowed, with no price. */
export const offeredModels = () =>
  Object.entries(PRICES).map(([key, price]) => {
    const [provider, model] = key.split("/") as [string, string]
    return {
      provider,
      model,
      default: provider === DEFAULT_OFFER.provider && model === DEFAULT_OFFER.model,
      usd_per_million: {
        input: Math.round(price.input * 1e8) / 100,
        output: Math.round(price.output * 1e8) / 100,
      },
    }
  })

export const enrichmentPrice = (provider: string, model: string, baseUrl?: string) =>
  baseUrl === undefined ? PRICES[`${provider}/${model}`] : undefined

/**
 * Per record, measured with this prompt and gpt-4o-mini on 1,048 synthetic records of about 100 characters, 20 to a
 * request (cli-testing write-time-enrichment, 2026-11-08): 66 input tokens, 41 of them the prompt's share, and 65
 * output tokens.
 */
const OUTPUT_TOKENS_PER_RECORD = 70
const PROMPT_TOKENS_PER_RECORD = 40

export interface EnrichmentEstimate {
  records: number
  input_tokens: number
  output_tokens: number
  /** `null` for a model or endpoint with no known price. */
  usd: number | null
}

export const estimateEnrichment = (
  records: number,
  chars: number,
  setting?: Pick<EnrichmentSetting, "provider" | "model" | "base_url">,
): EnrichmentEstimate => {
  const input = Math.ceil(chars / 4) + records * PROMPT_TOKENS_PER_RECORD
  const output = records * OUTPUT_TOKENS_PER_RECORD
  const price = setting && enrichmentPrice(setting.provider, setting.model, setting.base_url)
  return {
    records,
    input_tokens: input,
    output_tokens: output,
    usd: price ? Math.round((input * price.input + output * price.output) * 1_000_000) / 1_000_000 : null,
  }
}

export const costOf = (
  usage: { input: number; output: number },
  setting: Pick<EnrichmentSetting, "provider" | "model" | "base_url">,
): number | null => {
  const price = enrichmentPrice(setting.provider, setting.model, setting.base_url)
  return price ? Math.round((usage.input * price.input + usage.output * price.output) * 1_000_000) / 1_000_000 : null
}
