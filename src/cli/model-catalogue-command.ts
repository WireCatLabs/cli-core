import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { Command } from "commander"
import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, TEXT_MODELS } from "../embeddings/models.js"
import type { AppIdentity } from "../ports/app.js"
import { downloadTextModel } from "../services/model-downloads.js"
import { install, installedBytes, isInstalled, modelsDirectory } from "../speech/install.js"
import { DEFAULT_ORDER, orderedModels, speechModel } from "../speech/models.js"
import { FETCH, LOCAL_READ, NO_EFFECTS } from "./effects.js"
import { type Body, itemOf, listOf } from "./envelope.js"
import { listQuery, nativeTerms, termField, typedQuery, withQuery } from "./list-query.js"

export const MODEL_CATALOGUE_QUERY = defineQuery({
  entity: "model",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:audio", { values: ["audio", "text", "reranker"] }),
    termField("id", "kw", "id:e5-small"),
    termField("downloaded", "bool", "downloaded:true"),
  ],
})

export interface ModelCatalogueOptions {
  kinds: readonly ("audio" | "text")[]
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
  jsonOption?: boolean
  offline?: () => boolean
  defaultAudio?: () => string
}

/** Provider composition supplies I/O and supported kinds; parsing, receipts and download policy stay shared. */
export const modelCatalogueCommand = (app: AppIdentity, options: ModelCatalogueOptions): Command => {
  if (options.kinds.length === 0) throw new CliError("configuration_error", "declare at least one supported model kind")
  const audio = (id: string, env: NodeJS.ProcessEnv) => {
    const model = speechModel(id)
    const directory = modelsDirectory(env)
    return {
      id,
      kind: "audio",
      title: model.title,
      languages: model.languages,
      size_bytes: installedBytes(model),
      downloaded: isInstalled(model, directory),
      default: id === (options.defaultAudio?.() ?? DEFAULT_ORDER[0]),
      path: join(directory, id),
    }
  }
  const text = (id: string, env: NodeJS.ProcessEnv) => {
    const model = TEXT_MODELS.find((one) => one.id === id)
    if (!model) throw new CliError("validation_error", `unknown text model ${id}`)
    const directory = textModelsDirectory(env)
    return {
      id,
      kind: "text",
      title: model.title,
      languages: model.languages,
      licence: model.licence,
      size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
      downloaded: isTextModelInstalled(model, directory),
      default: id === DEFAULT_TEXT_MODEL,
      path: join(directory, id),
    }
  }
  const models = annotate(new Command("models"), { effects: NO_EFFECTS }).description("models that run on this machine")
  withQuery(
    annotate(models.command("list"), {
      effects: LOCAL_READ,
      output: { entity: "model" },
      examples: [`${app.command} models list`, `${app.command} models list kind:${options.kinds[0]}`],
    }),
    MODEL_CATALOGUE_QUERY,
  )
    .description("speech and embedding models, their download status and the default of each kind")
    .action(function (this: Command, words: string[]) {
      const terms = nativeTerms(listQuery(typedQuery(words), MODEL_CATALOGUE_QUERY, "models list"), "models list")
      const env = options.env()
      const items = [
        ...(options.kinds.includes("audio") ? orderedModels().map((model) => audio(model.id, env)) : []),
        ...(options.kinds.includes("text") ? TEXT_MODELS.map((model) => text(model.id, env)) : []),
      ].filter(
        (item) =>
          (terms.get("kind") === undefined || item.kind === terms.get("kind")?.value) &&
          (terms.get("id") === undefined || item.id === terms.get("id")?.value) &&
          (terms.get("downloaded") === undefined || item.downloaded === (terms.get("downloaded")?.value === "true")),
      )
      options.output(listOf("models list", { items, limit: Math.max(1, items.length), has_more: false }), this)
    })
  annotate(models.command("download"), {
    effects: FETCH,
    output: { entity: "model" },
    examples: [
      `${app.command} models download ${options.kinds.includes("text") ? DEFAULT_TEXT_MODEL : DEFAULT_ORDER[0]}`,
    ],
  })
    .description("download and verify one speech or embedding model")
    .argument("<model>", "a model id from models list")
    .option("--offline", "refuse a download that needs the network")
    .option("--accept-terms", "accept the model's licence terms, for a model that has its own")
    .action(async function (this: Command, id: string, given: { acceptTerms?: boolean }) {
      if (options.offline?.() || this.optsWithGlobals<{ offline?: boolean }>().offline)
        throw new CliError("permission_error", "downloading a model needs the network; --offline was requested", {
          reason: "model.offline",
        })
      const env = options.env()
      if (TEXT_MODELS.some((model) => model.id === id)) {
        if (!options.kinds.includes("text"))
          throw new CliError("validation_error", "this tool does not use text models")
        await downloadTextModel(id, { env, acceptTerms: given.acceptTerms === true, progress: options.diagnostic })
        options.output(itemOf(text(id, env)), this)
      } else {
        if (!options.kinds.includes("audio"))
          throw new CliError("validation_error", "this tool does not use audio models")
        await install(speechModel(id), modelsDirectory(env), { verifyExisting: true, progress: options.diagnostic })
        options.output(itemOf(audio(id, env)), this)
      }
    })
  if (options.jsonOption) for (const command of models.commands) command.option("--json", "print JSON")
  return models
}
