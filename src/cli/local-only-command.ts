import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { chosenTextModel } from "../embeddings/models.js"
import { aiBaseUrl, aiLeavesComputer, aiSettingPath, readAiSetting } from "../models/ai.js"
import { onThisComputer } from "../models/endpoint.js"
import { readLocalOnly, writeLocalOnly } from "../models/local-only.js"
import type { AppIdentity } from "../ports/app.js"
import { agentOf } from "../runs/run-context.js"
import { enrichmentEndpoint, readEnrichmentSetting } from "../services/enrichment-setting.js"
import { readHarderSetting } from "../services/search-harder.js"
import { environmentOf } from "./context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE } from "./effects.js"
import { type Body, itemOf } from "./envelope.js"

export interface LocalOnlyCommandOptions {
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
}

type Where = "this-computer" | "elsewhere" | "agent" | "off"

interface Feature {
  id: string
  title: string
  /** Where its data goes now: this computer, another address, the agent that runs it, or nowhere (off). */
  where: Where
  address: string | null
  /** Whether local only stops it: an address elsewhere is refused; an agent is outside WireCat. */
  refused: boolean
  note: string
}

const placeOf = (address: string): Where => (onThisComputer(address) ? "this-computer" : "elsewhere")

const read = <T>(get: () => T): T | undefined => {
  try {
    return get()
  } catch {
    return undefined
  }
}

const features = (command: string, env: NodeJS.ProcessEnv, on: boolean): Feature[] => {
  const ai = read(() => readAiSetting(aiSettingPath(env)))
  const aiAddress = ai ? aiBaseUrl(ai) : null
  const aiWhere: Where = ai ? (aiLeavesComputer(ai) ? "elsewhere" : "this-computer") : "off"
  const enrichment = read(() => readEnrichmentSetting(env))
  const enrichmentAddress = enrichment ? enrichmentEndpoint(enrichment) : null
  const harder = read(() => readHarderSetting(env))
  const harderAddress = harder ? enrichmentEndpoint(harder) : null
  const blocked = (where: Where) => on && where === "elsewhere"
  const one = (id: string, title: string, where: Where, address: string | null, note: string): Feature => ({
    id,
    title,
    where,
    address,
    refused: blocked(where),
    note,
  })
  return [
    one("ai_model", "AI model", aiWhere, aiAddress, `\`${command} models ai set\` chooses it`),
    one(
      "enrichment",
      "Rewrite records for better search",
      enrichmentAddress ? placeOf(enrichmentAddress) : "off",
      enrichmentAddress,
      `\`${command} models consents\``,
    ),
    one(
      "search_harder",
      "Search harder",
      harderAddress ? placeOf(harderAddress) : "off",
      harderAddress,
      `\`${command} models search-consents\``,
    ),
    one(
      "search_by_meaning",
      "Search by meaning and picture search",
      "this-computer",
      null,
      `the text model ${chosenTextModel(env).id}; a profile that sets embeddingProvider openai sends text out`,
    ),
    ...(
      [
        ["chat_linking", "Chat linking (--analyze)", "analysis"],
        ["replies", "Reply drafts", "replies"],
        ["attachment_ocr", "Picture text in attachments (--ocr)", "ocr"],
      ] as const
    ).map(([id, title, purpose]) =>
      one(
        id,
        title,
        aiWhere,
        aiAddress,
        `the AI model, unless a messenger profile sets models.${purpose}; that address is checked when it is called`,
      ),
    ),
    one(
      "voice_messages",
      "Voice messages",
      on ? "this-computer" : "elsewhere",
      null,
      on
        ? "the downloaded speech model only"
        : "the downloaded speech model first, else the messenger's own service; OpenAI only when asked by name",
    ),
    one("digest", "Digest", "agent", null, "runs Claude Code or Codex: local only if that agent runs a local model"),
    one("agents", "Agents over MCP", "agent", null, "whatever the agent reads goes to the agent's model"),
  ]
}

const state = (command: string, env: NodeJS.ProcessEnv) => {
  const setting = readLocalOnly(env)
  const on = setting?.on === true
  return { on, since: on ? (setting?.at ?? null) : null, features: features(command, env, on) }
}

/** `models local-only`: one switch that keeps every model call on this computer, and where each feature sends data. */
export const localOnlyCommand = (app: AppIdentity, options: LocalOnlyCommandOptions): Command => {
  const local = annotate(new Command("local-only"), { effects: LOCAL_READ }).description(
    "keep every model call on this computer: refuse any address that is not, in every WireCat tool",
  )
  annotate(local.command("show"), {
    effects: LOCAL_READ,
    output: { entity: "local_only" },
    examples: [`${app.command} models local-only show`],
  })
    .summary("whether local only is on, and where each feature sends data")
    .description("whether local only is on, and for each feature whether its data stays on this computer")
    .action(function (this: Command) {
      options.output(itemOf(state(app.command, options.env())), this)
    })
  grantsAuthority(
    annotate(local.command("set"), {
      effects: LOCAL_WRITE,
      mcp: false,
      output: { entity: "local_only" },
      examples: [`${app.command} models local-only set on`, `${app.command} models local-only set off`],
    }),
  )
    .description("turn local only on or off; only you turn it off")
    .argument("<state>", "on or off")
    .option("--from-app", "you did this in WireCat Desktop")
    .action(function (this: Command, given: string) {
      if (given !== "on" && given !== "off") throw new CliError("validation_error", "say on or off")
      const env = options.env()
      // An agent that turned it off would let records out for the owner; turning it on only refuses more.
      if (given === "off" && (environmentOf(this).agent || agentOf(env)) && !this.opts<{ fromApp?: boolean }>().fromApp)
        throw new CliError("permission_error", "only the owner turns local only off, not an agent", {
          reason: "local-only.owner-only",
        })
      const before = readLocalOnly(env)?.on === true
      if (before !== (given === "on")) writeLocalOnly(env, given === "on")
      const now = state(app.command, env)
      const out = now.features.filter((one) => one.refused).map((one) => one.title)
      if (given === "on" && out.length)
        options.diagnostic(`local only is on; these now refuse to send until they use this computer: ${out.join(", ")}`)
      options.output(itemOf({ ...now, changed: before !== (given === "on") }), this)
    })
  return local
}
