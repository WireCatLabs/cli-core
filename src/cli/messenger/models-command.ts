import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command, Option } from "commander"
import type * as v from "valibot"
import { isTextModelInstalled, textModelsDirectory } from "../../embeddings/embed.js"
import { embeddingKeys } from "../../embeddings/keys.js"
import { DEFAULT_TEXT_MODEL, TEXT_MODELS, type TextModel } from "../../embeddings/models.js"
import { model as modelEntity } from "../../entities/model.js"
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  type ImageModel,
  imageModelsDirectory,
  isImageModelInstalled,
} from "../../images/picture/models.js"
import { downloadImageModel, downloadTextModel } from "../../services/model-downloads.js"
import {
  install,
  installedBytes,
  isInstalled,
  megabytes,
  modelPath,
  modelsDirectory,
  vadPath,
} from "../../speech/install.js"
import { orderedModels, type SpeechModel, speechModel, VAD } from "../../speech/models.js"
import { choose } from "../../speech/transcribe.js"
import { readSecret } from "../../terminal/prompt.js"
import { baseContext, environmentOf } from "../context.js"
import { FETCH, grantsAuthority, LOCAL_READ, LOCAL_WRITE, reachesOtherService } from "../effects.js"
import { type Body, itemOf, listOf, renderAnswer } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { nextStep } from "../steps.js"
import type { Messenger } from "./context.js"

/**
 * Models that run on this machine, by what they work on; `audio` is the speech models behind
 * `messages transcribe --local`, `text` the embedding models behind `conversations embed`. Nothing here talks to the messenger. The folder is shared by every
 * messenger CLI, so a model downloaded once serves them all.
 */
type ModelItem = v.InferOutput<typeof modelEntity>

/** A model list is the catalog this version ships. */
const MODELS_QUERY = unfilteredQuery("model", modelEntity)

/** Every model this version knows: a short, fixed list, never paged. */
const everyModel = (command: string, items: ModelItem[], next: NextStep[] = []) =>
  listOf(command, { items, limit: Math.max(1, items.length), has_more: false, next })

const audioItem = (model: SpeechModel, directory: string, chosen: string): ModelItem => ({
  id: model.id,
  kind: "audio",
  title: model.title,
  languages: model.languages,
  size_bytes: installedBytes(model),
  downloaded: isInstalled(model, directory),
  default: model.id === chosen,
  path: join(directory, model.id),
})

const textItem = (model: TextModel, directory: string): ModelItem => ({
  id: model.id,
  kind: "text",
  title: model.title,
  languages: model.languages,
  licence: model.licence,
  size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
  downloaded: isTextModelInstalled(model, directory),
  default: model.id === DEFAULT_TEXT_MODEL,
  path: join(directory, model.id),
})

const imageItem = (model: ImageModel, directory: string): ModelItem => ({
  id: model.id,
  kind: "image",
  title: model.title,
  languages: model.languages,
  licence: model.licence,
  size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
  downloaded: isImageModelInstalled(model, directory),
  default: model.id === DEFAULT_IMAGE_MODEL,
  path: join(directory, model.id),
})

const downloaded = (body: Body<ModelItem>) =>
  "item" in body ? `${body.item.id}: downloaded and works, in ${body.item.path}\n` : ""

const modelLine = (item: ModelItem, width: number) =>
  `${item.default ? "*" : " "} ${item.id.padEnd(width)} ${megabytes(item.size_bytes).padStart(7)}  ` +
  (item.downloaded ? "downloaded" : "—".padEnd(10))

export const modelsCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const models = new Command("models").description("models that run on this machine")
  const audio = models.command("audio").description("speech models for transcribing voice messages")

  withQuery(
    annotate(audio.command("list"), { effects: LOCAL_READ, examples: [`${tool} models audio list`] }),
    MODELS_QUERY,
  )
    .summary("speech models and their download status")
    .description("the speech models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command, words: string[]) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        listQuery(typedQuery(words), MODELS_QUERY, "models audio list")
        const directory = modelsDirectory(context.env)
        const chosen = choose(messenger, context.settings, {}, context.env).model.id
        const items = orderedModels(messenger.speechModels).map((model) => audioItem(model, directory, chosen))
        renderAnswer(this, context, everyModel("models audio list", items), () =>
          items.map((item) => `${modelLine(item, 14)}  ${item.languages}\n`).join(""),
        )
        if (context.format === "pretty") context.renderer.note(`kept in ${directory}`)
      })
    })

  reachesOtherService(
    annotate(audio.command("download"), {
      effects: FETCH,
      output: { entity: "model" },
      examples: [`${tool} models audio download parakeet-v3`],
    }),
  )
    .argument("<model>", "a model id from `models audio list`")
    .description("download a speech model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const model = speechModel(id)
          const directory = modelsDirectory(context.env)
          if (!isInstalled(model, directory)) {
            context.renderer.note(
              `${model.id}: ${megabytes(installedBytes(model) + VAD.bytes)} from Hugging Face and GitHub`,
            )
            await install(model, directory, { progress: (line) => context.renderer.note(line) })
          }
          // Loading is the test — the files, the WebAssembly engine and the memory it needs — on a
          // second of silence, since no recording ships with the package.
          context.renderer.note(`${model.id}: loading it once to check it works`)
          const { openRecognizer, SAMPLE_RATE } = await import("../../speech/recognize.js")
          const recognizer = openRecognizer(model, modelPath(directory, model), vadPath(directory))
          try {
            recognizer.recognize(new Float32Array(SAMPLE_RATE))
          } finally {
            recognizer.free()
          }
          const chosen = choose(messenger, context.settings, {}, context.env).model.id
          renderAnswer(this, context, itemOf(audioItem(model, directory, chosen)), downloaded)
        },
        { unbounded: true },
      )
    })

  const text = models.command("text").description("embedding models for searching conversations by meaning")

  withQuery(
    annotate(text.command("list"), { effects: LOCAL_READ, examples: [`${tool} models text list`] }),
    MODELS_QUERY,
  )
    .summary("embedding models and their download status")
    .description("the embedding models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command, words: string[]) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        listQuery(typedQuery(words), MODELS_QUERY, "models text list")
        const directory = textModelsDirectory(context.env)
        const items = TEXT_MODELS.map((model) => textItem(model, directory))
        const missing = items.find((item) => item.default && !item.downloaded)
        renderAnswer(
          this,
          context,
          everyModel(
            "models text list",
            items,
            missing ? [nextStep("models.download", { args: { model: missing.id } })] : [],
          ),
          () => items.map((item) => `${modelLine(item, 16)}  ${item.licence}\n`).join(""),
        )
        if (context.format === "pretty") context.renderer.note(`kept in ${directory}`)
      })
    })

  reachesOtherService(
    annotate(text.command("download"), {
      effects: FETCH,
      output: { entity: "model" },
      examples: [`${tool} models text download ${DEFAULT_TEXT_MODEL}`],
    }),
  )
    .argument("<model>", "a model id from `models text list`")
    .addOption(new Option("--accept-terms", "accept the model's licence terms, for a model that has its own"))
    .summary("download and verify an embedding model")
    .description("download an embedding model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string, options: { acceptTerms?: boolean }) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const { model, directory } = await downloadTextModel(id, {
            env: context.env,
            acceptTerms: options.acceptTerms === true,
            progress: (line) => context.renderer.note(line),
          })
          renderAnswer(this, context, itemOf(textItem(model, directory)), downloaded)
        },
        { unbounded: true },
      )
    })

  const key = text.command("key").description("API keys for embedding and analysis providers")

  grantsAuthority(
    annotate(key.command("set"), {
      effects: LOCAL_WRITE,
      output: { entity: "model_key", view: "stored" },
      examples: [`${tool} models text key set openai`],
    }),
  )
    .argument("<provider>", "openai, anthropic, or the host of a --base-url server that wants a key")
    .description("store a key, typed at a hidden prompt or piped on stdin — never as an argument")
    .action(async function (this: Command, provider: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const stdin = environmentOf(this).stdin
        const secret = (await readSecret(`API key for ${provider}: `, stdin ? { input: stdin } : {})).trim()
        if (!secret) throw new CliError("validation_error", "no key was given — nothing was stored")
        const source = embeddingKeys(messenger.app, context.env, context.keyring).write(provider, secret)
        renderAnswer(this, context, itemOf({ provider, stored: source }))
      })
    })

  grantsAuthority(
    annotate(key.command("remove"), {
      effects: LOCAL_WRITE,
      output: { entity: "model_key", view: "removed" },
      examples: [`${tool} models text key remove openai`],
    }),
  )
    .argument("<provider>", "openai, anthropic, or a server's host")
    .description("forget a stored key")
    .action(async function (this: Command, provider: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        renderAnswer(
          this,
          context,
          itemOf({ provider, removed: embeddingKeys(messenger.app, context.env, context.keyring).remove(provider) }),
        )
      })
    })

  return models
}

/** `images models`: registered with picture search, the only thing these models serve. */
export const imageModelsCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  const image = new Command("models").description("models that read pictures, for `images embed` and picture search")

  withQuery(
    annotate(image.command("list"), { effects: LOCAL_READ, examples: [`${tool} images models list`] }),
    MODELS_QUERY,
  )
    .description("the picture models, which are downloaded, and which one is the default")
    .action(async function (this: Command, words: string[]) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        listQuery(typedQuery(words), MODELS_QUERY, "images models list")
        const directory = imageModelsDirectory(context.env)
        const items = IMAGE_MODELS.map((model) => imageItem(model, directory))
        const missing = items.find((item) => item.default && !item.downloaded)
        renderAnswer(
          this,
          context,
          everyModel(
            "images models list",
            items,
            missing ? [nextStep("models.download-image", { args: { model: missing.id } })] : [],
          ),
          () => items.map((item) => `${modelLine(item, 16)}  ${item.licence}  ${item.languages}\n`).join(""),
        )
        if (context.format === "pretty") context.renderer.note(`kept in ${directory}`)
      })
    })

  reachesOtherService(
    annotate(image.command("download"), {
      effects: FETCH,
      output: { entity: "model" },
      examples: [`${tool} images models download ${DEFAULT_IMAGE_MODEL}`],
    }),
  )
    .argument("<model>", "a model id from `images models list`")
    .description("download a picture model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const { model, directory } = await downloadImageModel(id, {
            env: context.env,
            progress: (line) => context.renderer.note(line),
          })
          renderAnswer(this, context, itemOf(imageItem(model, directory)), downloaded)
        },
        { unbounded: true },
      )
    })

  return image
}
