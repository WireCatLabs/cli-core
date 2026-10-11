import { CliError } from "@wirecat/cli-base"
import { Command, Option } from "commander"
import { isTextModelInstalled, placedText, textModelsDirectory } from "../../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, TEXT_MODELS, textModel } from "../../embeddings/models.js"
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
import { listed } from "../paging.js"
import type { Messenger } from "./context.js"

/**
 * Models that run on this machine, by what they work on; `audio` is the speech models behind
 * `messages transcribe --local`, `text` the embedding models behind `conversations embed`. Nothing here talks to the messenger. The folder is shared by every
 * messenger CLI, so a model downloaded once serves them all.
 */
export const modelsCommand = (messenger: Messenger): Command => {
  const models = new Command("models").description("models that run on this machine")
  const audio = models.command("audio").description("speech models for transcribing voice messages")

  audio
    .command("list")
    .description("the speech models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = modelsDirectory(context.env)
        const chosen = choose(messenger, context.settings, {}, context.env).model.id
        const items = orderedModels(messenger.speechModels).map((model) => ({
          id: model.id,
          title: model.title,
          languages: model.languages,
          size: megabytes(installedBytes(model)),
          downloaded: isInstalled(model, directory),
          default: model.id === chosen,
        }))
        if (context.format === "pretty") {
          const line = (item: (typeof items)[number]) =>
            `${item.default ? "*" : " "} ${item.id.padEnd(14)} ${item.size.padStart(7)}  ${item.downloaded ? "downloaded" : "—".padEnd(10)}  ${item.languages}`
          context.streams.data(`${items.map(line).join("\n")}\n`)
        } else if (context.format === "jsonl") context.renderer.stream(items)
        else context.renderer.result({ ...listed(items), directory })
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

  text
    .command("list")
    .description("the embedding models, most suitable first, which are downloaded, and which one is the default")
    .action(async function (this: Command) {
      const context = baseContext(this, messenger.resolveSettings)
      await context.run(async () => {
        const directory = textModelsDirectory(context.env)
        const items = TEXT_MODELS.map((model) => ({
          id: model.id,
          title: model.title,
          languages: model.languages,
          licence: model.licence,
          size: megabytes(model.files.reduce((sum, file) => sum + file.bytes, 0)),
          downloaded: isTextModelInstalled(model, directory),
          default: model.id === DEFAULT_TEXT_MODEL,
        }))
        if (context.format === "pretty") {
          const line = (item: (typeof items)[number]) =>
            `${item.default ? "*" : " "} ${item.id.padEnd(16)} ${item.size.padStart(7)}  ${item.downloaded ? "downloaded" : "—".padEnd(10)}  ${item.licence}`
          context.streams.data(`${items.map(line).join("\n")}\n`)
        } else if (context.format === "jsonl") context.renderer.stream(items)
        else context.renderer.result({ ...listed(items), directory })
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
