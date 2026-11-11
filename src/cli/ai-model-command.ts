import { CliError, type KeyringStore } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import {
  AI_PROVIDERS,
  type AiSetting,
  aiBaseUrl,
  aiImagesAllowed,
  aiKeys,
  aiLeavesComputer,
  aiOrigin,
  aiSettingOf,
  aiSettingPath,
  aiTakesKey,
  checkAi,
  readAiSetting,
  writeAiSetting,
} from "../models/ai.js"
import { localOnly, localOnlyRefusal } from "../models/local-only.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { readSecret } from "../terminal/prompt.js"
import { environmentOf } from "./context.js"
import { FETCH, grantsAuthority, LOCAL_READ, LOCAL_WRITE, NO_EFFECTS } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface AiModelCommandOptions {
  env: () => NodeJS.ProcessEnv
  keyring?: KeyringStore
  stdin?: () => NodeJS.ReadableStream | undefined
  fetch?: typeof globalThis.fetch
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
}

const imagesNote = (setting: AiSetting) =>
  `images you add to memory are sent to ${new URL(aiBaseUrl(setting)).host} to be read${
    setting.provider === "ollama" ? " (on this computer)" : ", so they leave this computer"
  }`

const view = (app: AppIdentity, options: AiModelCommandOptions, setting: AiSetting | undefined) => {
  if (!setting)
    return {
      provider: null,
      model: null,
      base_url: null,
      origin: null,
      beta: false,
      images: false,
      key: { stored: false, source: null },
    }
  const key = aiTakesKey(setting) ? aiKeys(app, options.env(), options.keyring).read(aiOrigin(setting)) : undefined
  return {
    provider: setting.provider,
    model: setting.model,
    base_url: aiBaseUrl(setting),
    origin: aiOrigin(setting),
    beta: setting.provider === "ollama",
    images: aiImagesAllowed(setting),
    key: { stored: key !== undefined, source: key?.source ?? null },
  }
}

// An agent that pointed the model elsewhere, or spent the owner's credit, would act for the owner; only they may.
// --from-app is Desktop saying the owner clicked; like the other owner-only guards, it stops mistakes, not attacks.
const ownerOnly = (command: Command, env: NodeJS.ProcessEnv, what: string) => {
  if ((environmentOf(command).agent || agentOf(env)) && !command.opts<{ fromApp?: boolean }>().fromApp)
    throw new CliError("permission_error", `only the owner runs models ai ${what}, not an agent`, {
      reason: "ai.owner-only",
    })
}

// A broken or newer section must not stop the owner from replacing or clearing it.
const previous = (path: string): AiSetting | undefined => {
  try {
    return readAiSetting(path)
  } catch {
    return undefined
  }
}

/** `models ai`: the one model every WireCat tool may use in place of an agent, kept in the shared config. */
export const aiModelCommand = (app: AppIdentity, options: AiModelCommandOptions): Command => {
  const ai = annotate(new Command("ai"), { effects: NO_EFFECTS }).description(
    "the AI model WireCat may use instead of your agent: provider, model and its key",
  )
  annotate(ai.command("show"), {
    effects: LOCAL_READ,
    output: { entity: "ai_model" },
    examples: [`${app.command} models ai show`],
  })
    .summary("the chosen model, its key, and whether images may go to it")
    .description("the chosen model, whether a key is stored for its address, and whether images may go to it")
    .action(function (this: Command) {
      options.output(itemOf(view(app, options, readAiSetting(aiSettingPath(options.env())))), this)
    })
  grantsAuthority(
    annotate(ai.command("set"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "ai_model", view: "chosen" },
      examples: [
        `${app.command} models ai set anthropic --model claude-haiku-4-5 --secret-stdin --allow-remote`,
        `${app.command} models ai set openai --model openai/gpt-4o-mini --base-url https://openrouter.ai/api/v1 --secret-stdin`,
        `${app.command} models ai set ollama --model llama3.2-vision`,
      ],
    }),
  )
    .summary("choose the AI model: anthropic, openai or compatible, or ollama (beta)")
    .description(
      "choose the model: anthropic, openai (or any service that works like it, with --base-url) or ollama (beta)",
    )
    .argument("<provider>", AI_PROVIDERS.join(", "))
    .requiredOption("--model <model>", "the model's name as the provider writes it")
    .option("--base-url <url>", "the service's address; https, or http only on this computer")
    .option("--secret-stdin", "read the API key from stdin, or ask for it; kept for this address only")
    .option(
      "--allow-remote",
      "let images you add to memory go to this model to be read; they leave this computer. Without it, a set " +
        "takes back an earlier yes",
    )
    .option("--from-app", "you did this in WireCat Desktop")
    .action(async function (
      this: Command,
      provider: string,
      given: { model: string; baseUrl?: string; secretStdin?: boolean; allowRemote?: boolean },
    ) {
      const env = options.env()
      ownerOnly(this, env, "set")
      const path = aiSettingPath(env)
      const before = previous(path)
      const setting = aiSettingOf({
        provider,
        model: given.model,
        baseUrl: given.baseUrl,
        allowImages: given.allowRemote,
      })
      if (aiLeavesComputer(setting) && localOnly(env))
        throw localOnlyRefusal("what WireCat sends to its AI model", new URL(aiBaseUrl(setting)).host)
      if (given.secretStdin) {
        if (!aiTakesKey(setting)) throw new CliError("validation_error", "Ollama on this computer takes no key")
        const input = options.stdin?.()
        const secret = (await readSecret("API key: ", input ? { input } : {})).trim()
        if (!secret) throw new CliError("validation_error", "no key was given; nothing was changed")
        aiKeys(app, env, options.keyring).write(aiOrigin(setting), secret)
      }
      writeAiSetting(path, setting)
      if (setting.images) options.diagnostic(imagesNote(setting))
      const changed =
        JSON.stringify(before === undefined ? null : { ...before, images: aiImagesAllowed(before) }) !==
        JSON.stringify({ ...setting, images: aiImagesAllowed(setting) })
      options.output(itemOf({ ...view(app, options, setting), changed }), this)
    })
  grantsAuthority(
    annotate(ai.command("unset"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "ai_model", view: "off" },
      examples: [`${app.command} models ai unset`],
    }),
  )
    .description("stop using a model; its key stays until models ai remove")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command) {
      const env = options.env()
      ownerOnly(this, env, "unset")
      const path = aiSettingPath(env)
      const before = previous(path)
      writeAiSetting(path, undefined)
      options.output(itemOf({ changed: before !== undefined, key_kept: true }), this)
    })
  grantsAuthority(
    annotate(ai.command("remove"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "ai_model", view: "key-removed" },
      examples: [`${app.command} models ai remove https://api.anthropic.com`],
    }),
  )
    .description("remove the key stored for an address")
    .argument("[origin]", "the address, for example https://openrouter.ai; the chosen model's when absent")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command, given?: string) {
      const env = options.env()
      ownerOnly(this, env, "remove")
      const setting = given ? undefined : previous(aiSettingPath(env))
      let origin = setting ? aiOrigin(setting) : ""
      if (given) {
        const url = URL.canParse(given) ? new URL(given) : undefined
        if (!url || !["https:", "http:"].includes(url.protocol))
          throw new CliError("validation_error", "give the address as https://host")
        origin = url.origin
      }
      if (!origin) throw new CliError("validation_error", "no model is chosen; name the address")
      const keys = aiKeys(app, env, options.keyring)
      const removed = keys.remove(origin)
      // An older per-tool key or OPENAI_API_KEY/ANTHROPIC_API_KEY still answers for the official addresses.
      const still = keys.read(origin)?.source ?? null
      if (still) options.diagnostic(`a key for ${origin} is still found in ${still}; remove it there too`)
      options.output(itemOf({ origin, removed: removed.length > 0, still_found: still }), this)
    })
  grantsAuthority(
    annotate(ai.command("revoke"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "ai_model", view: "chosen" },
      examples: [`${app.command} models ai revoke`],
    }),
  )
    .description("stop sending images to the AI model; the model itself stays chosen")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command) {
      const env = options.env()
      ownerOnly(this, env, "revoke")
      const path = aiSettingPath(env)
      const setting = readAiSetting(path)
      if (!setting) throw new CliError("configuration_error", "no AI model is chosen", { reason: "ai.not-set" })
      const { images, ...kept } = setting
      if (images !== undefined) writeAiSetting(path, kept)
      options.output(itemOf({ ...view(app, options, kept), changed: images !== undefined }), this)
    })
  annotate(ai.command("check"), {
    effects: FETCH,
    mcp: false,
    output: { entity: "ai_model_check" },
    examples: [`${app.command} models ai check`],
  })
    .summary("send one short paid request and say what is wrong")
    .description("send one short request (billed by the provider, usually under a cent) and say what is wrong")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(async function (this: Command) {
      const env = options.env()
      ownerOnly(this, env, "check")
      const setting = readAiSetting(aiSettingPath(env))
      const result = await checkAi({ app, env, keyring: options.keyring, fetch: options.fetch })
      options.output(
        itemOf({
          ...result,
          provider: setting?.provider ?? null,
          model: setting?.model ?? null,
          origin: setting ? aiOrigin(setting) : null,
        }),
        this,
      )
    })
  return ai
}
