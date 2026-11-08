import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { type EnrichmentState, enrichmentState } from "../services/enrichment.js"
import {
  ENRICHMENT_PROVIDERS,
  type EnrichmentSetting,
  enrichmentEndpoint,
  isEnrichmentProvider,
  readEnrichmentSetting,
  writeEnrichmentSetting,
} from "../services/enrichment-setting.js"
import { openStore } from "../store/store.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface EnrichmentConsentsOptions {
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
}

const withStore = async <T>(env: NodeJS.ProcessEnv, work: (store: Awaited<ReturnType<typeof openStore>>) => T) => {
  const store = await openStore({ env })
  try {
    return await work(store)
  } finally {
    await store.close()
  }
}

const usd = (value: number | null) => (value === null ? "an unknown amount (no price for this model)" : `$${value}`)

/** What the owner agrees to, in the words the window shows above the switch. */
export const consentWording = (
  command: string,
  setting: Pick<EnrichmentSetting, "provider" | "model" | "base_url">,
  state: EnrichmentState,
): string =>
  `Enrichment sends the text of every note, document and email in this store to ${setting.provider} ` +
  `(${new URL(enrichmentEndpoint(setting)).host}), model ${setting.model}: ${state.pending} records now, and every ` +
  "record added or changed later, at each sync. The model writes facts and questions about each record; they are " +
  "kept in the store, and search finds the record by them. " +
  `Enriching what is here now costs about ${usd(state.estimate.usd)} ` +
  `(${state.estimate.input_tokens} input and ${state.estimate.output_tokens} output tokens). ` +
  `\`${command} models consents revoke\` turns it off and deletes what the model wrote.`

/**
 * Write-time enrichment: the owner's consent that notes, documents and mail go to a hosted model, which writes facts
 * and questions search reads beside each record. Off until `set … --yes`; one setting for every WireCat CLI.
 */
export const enrichmentConsentsCommand = (app: AppIdentity, options: EnrichmentConsentsOptions): Command => {
  const consents = annotate(new Command("consents"), { effects: LOCAL_READ }).description(
    "consent to send stored notes, documents and mail to a hosted model that rewrites them for search; off by default",
  )
  annotate(consents.command("show"), { effects: LOCAL_READ, examples: [`${app.command} models consents show`] })
    .description("whether enrichment is on, with which provider and model, how many records it covers and the cost")
    .action(async function (this: Command) {
      const env = options.env()
      const state = await withStore(env, (store) => enrichmentState(store, env))
      options.output(itemOf(state), this)
    })
  grantsAuthority(
    annotate(consents.command("set"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} models consents set openai --model gpt-4o-mini --yes`],
    }),
  )
    .description(
      "turn enrichment on for one provider and model; without --yes, say what would be sent and change nothing",
    )
    .argument("<provider>", `the provider that receives the records: ${ENRICHMENT_PROVIDERS.join(" or ")}`)
    .requiredOption("--model <model>", "the provider's model name, such as gpt-4o-mini or claude-haiku-5-5")
    .option("--base-url <url>", "the address of an OpenAI-compatible model API, or the Anthropic API root")
    .option("--yes", "agree that the records go to this provider, and turn enrichment on")
    .action(async function (
      this: Command,
      provider: string,
      given: { model: string; baseUrl?: string; yes?: boolean },
    ) {
      if (!isEnrichmentProvider(provider))
        throw new CliError(
          "validation_error",
          `enrichment goes to ${ENRICHMENT_PROVIDERS.join(" or ")}, not ${provider}`,
        )
      const env = options.env()
      // An agent that turned this on would send the owner's whole store out; only the owner may.
      if (agentOf(env) && given.yes)
        throw new CliError("permission_error", "only the owner turns enrichment on, not an agent", {
          reason: "enrichment.owner-only",
        })
      const chosen = {
        provider,
        model: given.model,
        ...(given.baseUrl === undefined ? {} : { base_url: given.baseUrl }),
      }
      const state = await withStore(env, (store) => enrichmentState(store, env, chosen))
      const consent = consentWording(app.command, chosen, state)
      if (!given.yes) {
        options.diagnostic(`${consent}\nNothing changed — add --yes to turn it on.`)
        options.output(itemOf({ ...state, changed: false, consent }), this)
        return
      }
      const setting: EnrichmentSetting = { ...chosen, consented_at: new Date().toISOString() }
      writeEnrichmentSetting(env, setting)
      options.diagnostic(`enrichment is on: ${provider} ${given.model}; the next syncs send ${state.pending} records`)
      options.output(
        itemOf({
          ...state,
          on: true,
          provider,
          model: given.model,
          endpoint: enrichmentEndpoint(setting),
          consented_at: setting.consented_at,
          changed: true,
          consent,
        }),
        this,
      )
    })
  grantsAuthority(
    annotate(consents.command("revoke"), {
      effects: LOCAL_WRITE,
      examples: [`${app.command} models consents revoke`],
    }),
  )
    .description("turn enrichment off and delete what the model wrote; search reads only the records' own text again")
    .action(async function (this: Command) {
      const env = options.env()
      const was = readEnrichmentSetting(env)
      writeEnrichmentSetting(env, undefined)
      const { deleted, state } = await withStore(env, async (store) => ({
        deleted: (await store.enrichment?.clear()) ?? 0,
        state: await enrichmentState(store, env),
      }))
      options.diagnostic(
        `enrichment is off${was ? ` (was ${was.provider} ${was.model})` : ""}; deleted the text written for ${deleted} records`,
      )
      options.output(itemOf({ ...state, changed: was !== undefined || deleted > 0, deleted }), this)
    })
  return consents
}
