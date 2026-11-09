import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { keyLookup, keyVariable } from "../services/enrichment.js"
import {
  ENRICHMENT_PROVIDERS,
  enrichmentEndpoint,
  enrichmentPrice,
  isEnrichmentProvider,
  readEnrichmentSetting,
} from "../services/enrichment-setting.js"
import {
  HARDER_CANDIDATES,
  HARDER_CHARS,
  HARDER_MODELS,
  type HarderSetting,
  readHarderSetting,
  writeHarderSetting,
} from "../services/search-harder.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface HarderConsentsOptions {
  env: () => NodeJS.ProcessEnv
  /** Where the key is looked for; the system keyring when absent. Tests pass memoryKeyring(). */
  keyring?: KeyringStore
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
}

type Choice = Pick<HarderSetting, "provider" | "model" | "base_url">

// One search: 30 hits of up to 400 characters plus the prompt, and a short list of hit numbers back.
const SEARCH_TOKENS = { input: 3_000, output: 60 }

const searchCost = (chosen: Choice): string => {
  const price = enrichmentPrice(chosen.provider, chosen.model, chosen.base_url)
  if (!price) return "the cost of one is unknown (no price for this model)"
  const usd = SEARCH_TOKENS.input * price.input + SEARCH_TOKENS.output * price.output
  return `one costs about $${Number(usd.toPrecision(1))}`
}

/** What the owner agrees to; a window can write the same text from the answer's fields. */
export const harderConsentWording = (command: string, chosen: Choice): string =>
  `\`${command} search all --harder\` sends the question and its first ${HARDER_CANDIDATES} hits (each one's title, ` +
  `date and up to ${HARDER_CHARS} characters of its text) to ${chosen.provider} ` +
  `(${new URL(enrichmentEndpoint(chosen)).host}), model ${chosen.model}, which puts the hits that answer it first. ` +
  `Only a search with --harder sends anything; ${searchCost(chosen)}, and it adds 1 to 2 seconds. ` +
  `\`${command} models search-consents revoke\` turns it off.`

const state = (app: AppIdentity, options: HarderConsentsOptions, given?: Choice) => {
  const env = options.env()
  const setting = readHarderSetting(env)
  // Enrichment's choice is only proposed: this consent is the owner's own, given here.
  const enrichment = setting === undefined && given === undefined ? readEnrichmentSetting(env) : undefined
  const chosen: Choice =
    given ??
    setting ??
    (enrichment
      ? {
          provider: enrichment.provider,
          model: enrichment.base_url === undefined ? HARDER_MODELS[enrichment.provider] : enrichment.model,
          ...(enrichment.base_url === undefined ? {} : { base_url: enrichment.base_url }),
        }
      : { provider: "anthropic", model: HARDER_MODELS.anthropic })
  const found = keyLookup({ env, app, ...(options.keyring ? { keyring: options.keyring } : {}) }, chosen)
  const price = enrichmentPrice(chosen.provider, chosen.model, chosen.base_url)
  return {
    on: setting !== undefined,
    provider: chosen.provider,
    model: chosen.model,
    endpoint: enrichmentEndpoint(chosen),
    ...(enrichment ? { proposed_from: "enrichment" } : {}),
    consented_at: setting?.consented_at ?? null,
    candidates: HARDER_CANDIDATES,
    chars_per_hit: HARDER_CHARS,
    usd_per_million: price
      ? { input: Math.round(price.input * 1e8) / 100, output: Math.round(price.output * 1e8) / 100 }
      : null,
    key: { present: found !== undefined, source: found?.source ?? null, env_var: keyVariable(chosen.provider) },
    consent: harderConsentWording(app.command, chosen),
    off_command: `${app.command} models search-consents revoke`,
  }
}

/**
 * The owner's consent that `search all --harder` may send a question and its hits to a hosted model. Off until
 * `set … --yes`; with it, still only a search that asks with --harder sends anything.
 */
export const harderConsentsCommand = (app: AppIdentity, options: HarderConsentsOptions): Command => {
  const consents = annotate(new Command("search-consents"), { effects: LOCAL_READ }).description(
    "consent that search all --harder sends the question and its first hits to a hosted model; off by default",
  )
  annotate(consents.command("show"), { effects: LOCAL_READ, examples: [`${app.command} models search-consents show`] })
    .description("whether search all --harder may call the model, which one, and whether its key is found")
    .action(function (this: Command) {
      options.output(itemOf(state(app, options)), this)
    })
  grantsAuthority(
    annotate(consents.command("set"), {
      effects: LOCAL_WRITE,
      examples: [
        `${app.command} models search-consents set anthropic --yes`,
        `${app.command} models search-consents set openai --base-url https://openrouter.ai/api/v1 --model deepseek/deepseek-chat`,
      ],
    }),
  )
    .description("allow search all --harder to call the model; without --yes, say what it sends and change nothing")
    .argument("<provider>", `the provider that receives the question and hits: ${ENRICHMENT_PROVIDERS.join(" or ")}`)
    .option(
      "--model <model>",
      `the provider's model; ${HARDER_MODELS.anthropic} or ${HARDER_MODELS.openai} if left out`,
    )
    .option("--base-url <url>", "the address of an OpenAI-compatible model API (OpenRouter…); needs --model")
    .option("--yes", "agree that a --harder search sends its question and hits, and allow it")
    .action(function (this: Command, provider: string, given: { model?: string; baseUrl?: string; yes?: boolean }) {
      if (!isEnrichmentProvider(provider))
        throw new CliError(
          "validation_error",
          `search all --harder calls ${ENRICHMENT_PROVIDERS.join(" or ")}, not ${provider}`,
        )
      // Another API's models have other names: a default from this list would be a guess.
      if (given.baseUrl !== undefined && given.model === undefined)
        throw new CliError("validation_error", "--base-url needs --model: name the model that API serves")
      const env = options.env()
      // An agent that turned this on would decide for the owner that his records may leave the machine.
      if (agentOf(env) && given.yes)
        throw new CliError("permission_error", "only the owner allows search all --harder, not an agent", {
          reason: "search-harder.owner-only",
        })
      const chosen: Choice = {
        provider,
        model: given.model ?? HARDER_MODELS[provider],
        ...(given.baseUrl === undefined ? {} : { base_url: given.baseUrl }),
      }
      if (!given.yes) {
        const now = state(app, options, chosen)
        options.diagnostic(`${now.consent}\nNothing changed — add --yes to allow it.`)
        options.output(itemOf({ ...now, changed: false }), this)
        return
      }
      writeHarderSetting(env, { ...chosen, consented_at: new Date().toISOString() })
      options.diagnostic(`search all --harder may now call ${provider} ${chosen.model}`)
      options.output(itemOf({ ...state(app, options), changed: true }), this)
    })
  grantsAuthority(
    annotate(consents.command("revoke"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} models search-consents revoke`],
    }),
  )
    .description("stop search all --harder from calling the model; it gives the plain order again")
    .action(function (this: Command) {
      const env = options.env()
      const was = readHarderSetting(env)
      writeHarderSetting(env, undefined)
      options.diagnostic(`search all --harder sends nothing now${was ? ` (was ${was.provider} ${was.model})` : ""}`)
      options.output(itemOf({ ...state(app, options), changed: was !== undefined }), this)
    })
  return consents
}
