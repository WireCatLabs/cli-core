import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Command, Option } from "commander"
import type * as v from "valibot"
import { isTextModelInstalled, placedText, textModelsDirectory } from "../../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, TEXT_MODELS, textModel } from "../../embeddings/models.js"
import type { model } from "../../entities/model.js"
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  imageModel,
  imageModelsDirectory,
  isImageModelInstalled,
  placedImage,
} from "../../images/picture/models.js"
import {
  install,
  installedBytes,
  installFiles,
  isInstalled,
  megabytes,
  modelPath,
  modelsDirectory,
  vadPath,
} from "../../speech/install.js"
import { orderedModels, speechModel, VAD } from "../../speech/models.js"
import { choose } from "../../speech/transcribe.js"
import { readSecret } from "../../terminal/prompt.js"
import { baseContext, environmentOf } from "../context.js"
import { embeddingKeys } from "../embedding-keys.js"
import { listOf, renderAnswer } from "../envelope.js"
import { nextStep } from "../steps.js"
import type { Messenger } from "./context.js"

/**
 * Models that run on this machine, by what they work on; `audio` is the speech models behind
 * `messages transcribe --local`, `text` the embedding models behind `conversations embed`. Nothing here talks to the messenger. The folder is shared by every
 * messenger CLI, so a model downloaded once serves them all.
 */
type ModelItem = v.InferOutput<typeof model>

/** Every model this version knows: a short, fixed list, never paged. */
const everyModel = (command: string, items: ModelItem[], next: NextStep[] = []) =>
  listOf(command, { items, limit: Math.max(1, items.length), has_more: false, next })

const modelLine = (item: ModelItem, width: number) =>
  `${item.default ? "*" : " "} ${item.id.padEnd(width)} ${megabytes(item.size_bytes).padStart(7)}  ` +
  (item.downloaded ? "downloaded" : "—".padEnd(10))

export const modelsCommand = (messenger: Messenger): Command => {
  const models = new Command("models").description("models that run on this machine")
  const audio = models.command("audio").description("speech models for transcribing voice messages")

  annotate(audio.command("list"), { output: { entity: "model" } })
    .description("the speech models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = modelsDirectory(context.env)
        const chosen = choose(messenger, context.settings, {}, context.env).model.id
        const items: ModelItem[] = orderedModels(messenger.speechModels).map((model) => ({
          id: model.id,
          kind: "audio",
          title: model.title,
          languages: model.languages,
          size_bytes: installedBytes(model),
          downloaded: isInstalled(model, directory),
          default: model.id === chosen,
        }))
        renderAnswer(this, context, everyModel("models audio list", items), () =>
          items.map((item) => `${modelLine(item, 14)}  ${item.languages}\n`).join(""),
        )
        if (context.format === "pretty") context.renderer.note(`kept in ${directory}`)
      })
    })

  audio
    .command("download")
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
          context.renderer.result({ id: model.id, downloaded: true, works: true, directory })
        },
        { unbounded: true },
      )
    })

  const text = models.command("text").description("embedding models for searching conversations by meaning")

  annotate(text.command("list"), { output: { entity: "model" } })
    .description("the embedding models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = textModelsDirectory(context.env)
        const items: ModelItem[] = TEXT_MODELS.map((model) => ({
          id: model.id,
          kind: "text",
          title: model.title,
          languages: model.languages,
          licence: model.licence,
          size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
          downloaded: isTextModelInstalled(model, directory),
          default: model.id === DEFAULT_TEXT_MODEL,
        }))
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

  text
    .command("download")
    .argument("<model>", "a model id from `models text list`")
    .addOption(new Option("--accept-terms", "accept the model's licence terms, for a model that has its own"))
    .description("download an embedding model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string, options: { acceptTerms?: boolean }) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const model = textModel(id)
          if (model.terms && !options.acceptTerms) {
            throw new CliError(
              "validation_error",
              `${model.id} comes under the ${model.licence} (${model.terms}): read them, then run this again with --accept-terms`,
            )
          }
          const directory = textModelsDirectory(context.env)
          if (!isTextModelInstalled(model, directory)) {
            context.renderer.note(
              `${model.id}: ${megabytes(model.files.reduce((sum, file) => sum + file.bytes, 0))} from Hugging Face`,
            )
            await installFiles(placedText(model, directory), { progress: (line) => context.renderer.note(line) })
          }
          context.renderer.note(`${model.id}: loading it once to check it works`)
          const { openEmbedder } = await import("../../embeddings/embed.js")
          const embedder = await openEmbedder(model, directory)
          try {
            const [vector] = await embedder.embed(["check"], "query")
            if (vector?.length !== model.dims)
              throw new CliError("invalid_response", `${model.id} gave a vector of the wrong size`)
          } finally {
            await embedder.close()
          }
          context.renderer.result({ id: model.id, downloaded: true, works: true, directory })
        },
        { unbounded: true },
      )
    })

  const image = models
    .command("image")
    .description("models that read pictures, for `images embed` and search by what a picture shows")

  annotate(image.command("list"), { output: { entity: "model" } })
    .description("the picture models, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = imageModelsDirectory(context.env)
        const items: ModelItem[] = IMAGE_MODELS.map((model) => ({
          id: model.id,
          kind: "image",
          title: model.title,
          languages: model.languages,
          licence: model.licence,
          size_bytes: model.files.reduce((sum, file) => sum + file.bytes, 0),
          downloaded: isImageModelInstalled(model, directory),
          default: model.id === DEFAULT_IMAGE_MODEL,
        }))
        const missing = items.find((item) => item.default && !item.downloaded)
        renderAnswer(
          this,
          context,
          everyModel(
            "models image list",
            items,
            missing ? [nextStep("models.download-image", { args: { model: missing.id } })] : [],
          ),
          () => items.map((item) => `${modelLine(item, 16)}  ${item.licence}  ${item.languages}\n`).join(""),
        )
        if (context.format === "pretty") context.renderer.note(`kept in ${directory}`)
      })
    })

  image
    .command("download")
    .argument("<model>", "a model id from `models image list`")
    .description("download a picture model once, checked against the sha256 this version expects")
    .action(async function (this: Command, id: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(
        async () => {
          const model = imageModel(id)
          const directory = imageModelsDirectory(context.env)
          if (!isImageModelInstalled(model, directory)) {
            context.renderer.note(
              `${model.id}: ${megabytes(model.files.reduce((sum, file) => sum + file.bytes, 0))} from Hugging Face`,
            )
            await installFiles(placedImage(model, directory), { progress: (line) => context.renderer.note(line) })
          }
          context.renderer.note(`${model.id}: loading it once to check it works`)
          const { openPictureEmbedder } = await import("../../images/picture/embedder.js")
          const embedder = await openPictureEmbedder(model, directory)
          try {
            const vector = await embedder.embedQuery("check")
            if (vector.length !== model.dims)
              throw new CliError("invalid_response", `${model.id} gave a vector of the wrong size`)
          } finally {
            await embedder.close()
          }
          context.renderer.result({ id: model.id, downloaded: true, works: true, directory })
        },
        { unbounded: true },
      )
    })

  const key = text.command("key").description("API keys for embedding and analysis providers")

  key
    .command("set")
    .argument("<provider>", "openai, anthropic, or the host of a --base-url server that wants a key")
    .description("store a key, typed at a hidden prompt or piped on stdin — never as an argument")
    .action(async function (this: Command, provider: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const stdin = environmentOf(this).stdin
        const secret = (await readSecret(`API key for ${provider}: `, stdin ? { input: stdin } : {})).trim()
        if (!secret) throw new CliError("validation_error", "no key was given — nothing was stored")
        const source = embeddingKeys(messenger.app, context.env).write(provider, secret)
        context.renderer.result({ provider, stored: source })
      })
    })

  key
    .command("remove")
    .argument("<provider>", "openai, anthropic, or a server's host")
    .description("forget a stored key")
    .action(async function (this: Command, provider: string) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        context.renderer.result({ provider, removed: embeddingKeys(messenger.app, context.env).remove(provider) })
      })
    })

  return models
}
