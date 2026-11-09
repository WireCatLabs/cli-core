import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { keyLookup, keyVariable } from "../services/enrichment.js"
import {
  DEFAULT_HARDER_MODEL,
  HARDER_CANDIDATES,
  HARDER_CHARS,
  HARDER_ENDPOINT,
  HARDER_PROVIDER,
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

/** What the owner agrees to; a window can write the same text from the answer's fields. */
export const harderConsentWording = (command: string, model: string): string =>
  `\`${command} search all --harder\` sends the question and its first ${HARDER_CANDIDATES} hits (each one's title, ` +
  `date and up to ${HARDER_CHARS} characters of its text) to ${HARDER_PROVIDER} (${new URL(HARDER_ENDPOINT).host}), ` +
  `model ${model}, which puts the hits that answer it first. Only a search with --harder sends anything; one costs ` +
  `about $0.0004 with claude-haiku-5-5 and adds 1 to 2 seconds. \`${command} models search-consents revoke\` turns it off.`

const state = (app: AppIdentity, options: HarderConsentsOptions, model?: string) => {
  const env = options.env()
  const setting = readHarderSetting(env)
  const found = keyLookup(
    { env, app, ...(options.keyring ? { keyring: options.keyring } : {}) },
    { provider: HARDER_PROVIDER },
  )
  const chosen = model ?? setting?.model ?? DEFAULT_HARDER_MODEL
  return {
    on: setting !== undefined,
    provider: HARDER_PROVIDER,
    model: chosen,
    endpoint: HARDER_ENDPOINT,
    consented_at: setting?.consented_at ?? null,
    candidates: HARDER_CANDIDATES,
    chars_per_hit: HARDER_CHARS,
    key: { present: found !== undefined, source: found?.source ?? null, env_var: keyVariable(HARDER_PROVIDER) },
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
      examples: [`${app.command} models search-consents set anthropic --yes`],
    }),
  )
    .description("allow search all --harder to call the model; without --yes, say what it sends and change nothing")
    .argument("<provider>", "the provider that receives the question and hits: anthropic")
    .option("--model <model>", "the provider's model name", DEFAULT_HARDER_MODEL)
    .option("--yes", "agree that a --harder search sends its question and hits, and allow it")
    .action(function (this: Command, provider: string, given: { model: string; yes?: boolean }) {
      if (provider !== HARDER_PROVIDER)
        throw new CliError("validation_error", `search all --harder calls ${HARDER_PROVIDER} only, not ${provider}`)
      const env = options.env()
      // An agent that turned this on would decide for the owner that his records may leave the machine.
      if (agentOf(env) && given.yes)
        throw new CliError("permission_error", "only the owner allows search all --harder, not an agent", {
          reason: "search-harder.owner-only",
        })
      if (!given.yes) {
        const now = state(app, options, given.model)
        options.diagnostic(`${now.consent}\nNothing changed — add --yes to allow it.`)
        options.output(itemOf({ ...now, changed: false }), this)
        return
      }
      writeHarderSetting(env, { provider: HARDER_PROVIDER, model: given.model, consented_at: new Date().toISOString() })
      options.diagnostic(`search all --harder may now call ${HARDER_PROVIDER} ${given.model}`)
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
