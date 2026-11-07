import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { defineQuery } from "@wirecat/cli-base/query"
import { Command } from "commander"
import { isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { chosenTextModel, DEFAULT_TEXT_MODEL, type TextModel, textModel, textModels } from "../embeddings/models.js"
import type { AppIdentity } from "../ports/app.js"
import { downloadTextModel } from "../services/model-downloads.js"
import { addCustomTextModel, type TextModelSwitch, useTextModel } from "../services/text-model-choice.js"
import { install, installedBytes, isInstalled, modelsDirectory } from "../speech/install.js"
import { DEFAULT_ORDER, orderedModels, speechModel } from "../speech/models.js"
import { stepLines } from "../terminal/step-lines.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE, NO_EFFECTS } from "./effects.js"
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
  const text = (id: string, env: NodeJS.ProcessEnv) => textModelItem(textModel(id, env), env)
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
        ...(options.kinds.includes("text") ? textModels(env).map((model) => textModelItem(model, env)) : []),
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
      const bytes = downloadProgress(
        stepLines(options.diagnostic, Boolean(this.optsWithGlobals<{ json?: unknown }>().json)),
        id,
      )
      if (textModels(env).some((model) => model.id === id)) {
        if (!options.kinds.includes("text"))
          throw new CliError("validation_error", "this tool does not use text models")
        await downloadTextModel(id, {
          env,
          acceptTerms: given.acceptTerms === true,
          progress: options.diagnostic,
          bytes,
        })
        options.output(itemOf(text(id, env)), this)
      } else {
        if (!options.kinds.includes("audio"))
          throw new CliError("validation_error", "this tool does not use audio models")
        await install(speechModel(id), modelsDirectory(env), {
          verifyExisting: true,
          progress: options.diagnostic,
          bytes,
        })
        options.output(itemOf(audio(id, env)), this)
      }
    })
  if (options.kinds.includes("text")) {
    annotate(models.command("set"), {
      effects: LOCAL_WRITE,
      output: { entity: "model" },
      examples: [`${app.command} models set e5-large`],
    })
      .summary(SET_SUMMARY)
      .description(SET_DESCRIPTION)
      .argument("<model>", "a downloaded text model id from models list")
      .action(async function (this: Command, id: string) {
        const env = options.env()
        const done = await useTextModel(id, { env, command: app.command })
        for (const line of switchNotes(done)) options.diagnostic(line)
        options.output(itemOf({ ...textModelItem(done.model, env), ...switchFields(done) }), this)
      })
    annotate(models.command("add"), {
      effects: FETCH,
      output: { entity: "model" },
      examples: [addExample(app.command)],
    })
      .description(ADD_DESCRIPTION)
      .argument("<id>", "the id to give it: a-z, 0-9, . _ -")
      .requiredOption("--payload <json>", "where the model is and how to run it, as JSON (below)")
      .option("--offline", "refuse a call that needs the network")
      .addHelpText("after", ADD_HELP)
      .action(async function (this: Command, id: string, given: { payload: string }) {
        if (options.offline?.() || this.optsWithGlobals<{ offline?: boolean }>().offline)
          throw new CliError("permission_error", "adding a model reads Hugging Face; --offline was requested", {
            reason: "model.offline",
          })
        const env = options.env()
        const model = await addCustomTextModel(id, payloadOf(given.payload), { env })
        options.diagnostic(`${model.id}: added — \`${app.command} models download ${model.id}\` fetches and checks it`)
        options.output(itemOf(textModelItem(model, env)), this)
      })
  }
  if (options.jsonOption) for (const command of models.commands) command.option("--json", "print JSON")
  return models
}

const PROGRESS_EVERY_MS = 500

/**
 * `{"event":"progress","step":"download",…}` on stderr under --json, for a window to draw a bar by: at most every half
 * second, but always the first line and the last.
 */
const downloadProgress = (emit: ReturnType<typeof stepLines>, label: string) => {
  let last = Number.NEGATIVE_INFINITY
  return (done: number, total: number) => {
    const now = Date.now()
    if (done !== total && now - last < PROGRESS_EVERY_MS) return
    last = now
    emit({ event: "progress", step: "download", done, total, unit: "bytes", label })
  }
}

/** One text model as `models list`, `download`, `use` and `add` print it, in every CLI. */
export const textModelItem = (model: TextModel, env: NodeJS.ProcessEnv) => {
  const directory = textModelsDirectory(env)
  return {
    id: model.id,
    kind: "text" as const,
    title: model.title,
    languages: model.languages,
    licence: model.licence,
    ...(model.terms ? { terms: model.terms } : {}),
    ...(model.size ? { size: model.size } : {}),
    dims: model.dims,
    ...(model.chunksPerSecond === undefined ? {} : { chunks_per_second: model.chunksPerSecond }),
    ...(model.custom ? { custom: true } : {}),
    size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
    downloaded: isTextModelInstalled(model, directory),
    default: model.id === chosenTextModel(env).id,
    path: join(directory, model.id),
  }
}

export const SET_SUMMARY = "use this text model for every embed and search by meaning, in every CLI"
export const SET_DESCRIPTION =
  "make a downloaded text model the one every embed and every search by meaning uses, in every WireCat CLI. " +
  "Each model keeps its own vectors: the next syncs embed what the new one lacks, and switching back is instant"

/** What `models set` adds to the model it prints. */
export const switchFields = ({ previous, toEmbed, estimateSeconds }: TextModelSwitch) => ({
  previous,
  to_embed: toEmbed,
  estimate_seconds: estimateSeconds,
})

export const switchNotes = ({ model, previous, toEmbed, estimateSeconds }: TextModelSwitch): string[] => {
  if (previous === model.id) return [`${model.id} is already the model in use`]
  const time =
    estimateSeconds === null
      ? ""
      : `, about ${estimateSeconds < 120 ? `${estimateSeconds} s` : `${Math.ceil(estimateSeconds / 60)} min`} here`
  return [
    `${model.id} is now in use instead of ${previous}; ${previous}'s vectors stay, so switching back is instant`,
    toEmbed === null
      ? "the next syncs embed everything again with it; until then search by meaning finds only what it has embedded, words find the rest"
      : `the next syncs embed about ${toEmbed} chunk${toEmbed === 1 ? "" : "s"} with it${time}; until then search by meaning finds only what it has embedded, words find the rest`,
  ]
}

export const ADD_DESCRIPTION = "add an ONNX embedding model from Hugging Face, pinned and checked by sha256"

export const addExample = (command: string) =>
  `${command} models add e5-base --payload '{"repository":"Xenova/multilingual-e5-base",` +
  `"onnx":"onnx/model_quantized.onnx","dims":768,"pooling":"mean","prefix":{"query":"query: ","passage":"passage: "}}'`

export const ADD_HELP = `
--payload is JSON:
  repository     the Hugging Face repository, owner/name
  revision       a branch, tag or commit (main); pinned to the commit it names now
  onnx           the ONNX file, e.g. onnx/model_quantized.onnx
  externalData   the weights file the ONNX file keeps beside itself, if any
  dims           the length of its vectors
  pooling        mean, or sentence_embedding for a model with that output
  prefix         {"query": "...", "passage": "..."}, put before a search and a stored text
  maxTokens      the longest text it reads (512); a longer one is cut
  title, languages, licence, chunksPerSecond   for models list; licence comes from the model card when left out
The repository needs tokenizer.json and tokenizer_config.json beside the ONNX file's folder.`

/** `--payload`'s JSON, refused with the reason when it does not parse. */
export const payloadOf = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new CliError("validation_error", `--payload is not JSON: ${(error as Error).message}`)
  }
}
