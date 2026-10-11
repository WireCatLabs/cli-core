import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { engineHint } from "../../attachments/extract.js"
import { gatewayOcr } from "../../attachments/gateway-ocr.js"
import type { AttachmentItem, ExtractItem, ExtractRun } from "../../services/attachments.js"
import { downloadMessage } from "../../services/file-download.js"
import { environmentOf } from "../context.js"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { stopOnSignal } from "./patience.js"
import { readAll } from "./stdin.js"

const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

const line = ({ status, locator, attachment, name, chars }: ExtractItem) =>
  `${status}  ${locator} #${attachment}${name ? `  ${name}` : ""}${chars === undefined ? "" : `  (${chars} characters)`}`

const summary = (run: ExtractRun) =>
  [
    `${run.extracted} extracted`,
    run.needsAgent ? `${run.needsAgent} for an agent to read (attachments text set)` : "",
    run.failed ? `${run.failed} unreadable` : "",
    run.unchanged ? `${run.unchanged} unchanged` : "",
    run.notDownloaded ? `${run.notDownloaded} not downloaded (--download)` : "",
    run.complete ? "" : "run it again to continue",
  ]
    .filter(Boolean)
    .join(", ")

const extractCommand = (messenger: Messenger): Command =>
  new Command("extract")
    .description(
      "read the text of downloaded files — text, PDF/DOCX text layers, ODT/ODS/XLSX/PPTX/EPUB — into the local store, for content: in a search",
    )
    .option("--chat <chat>", `only this chat's files; ${messenger.chatArgument}`)
    .option("--from-dir <dir>", "match files in this nonrecursive directory; needs --chat")
    .option("--cursor <cursor>", "continue from the cursor returned by a bounded extraction")
    .option("--download", "first save the files no download saved yet, from the messenger, into --output-dir")
    .option("--output-dir <dir>", "with --download, where to save them; created if missing")
    .option("--limit <n>", "read at most this many files; run it again to continue", count)
    .option("--ocr", "explicitly call models.ocr for bulk image and scanned-PDF text extraction")
    .option("--concurrency <n>", "remote: requests at once (default: 4)", count)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "attachments.extract")
      const { chat, download, outputDir, fromDir, cursor, limit, ocr, concurrency } = this.opts<{
        chat?: string
        download?: boolean
        outputDir?: string
        fromDir?: string
        cursor?: string
        limit?: number
        ocr?: boolean
        concurrency?: number
      }>()
      if (
        (concurrency !== undefined && (!ocr || concurrency > 8)) ||
        (ocr && (context.settings.offline || (limit !== undefined && limit > 500)))
      )
        throw new CliError(
          "validation_error",
          "API OCR needs online mode, concurrency1–8 and limit1–500; concurrency requires --ocr",
        )
      if (fromDir !== undefined && (chat === undefined || download || outputDir !== undefined))
        throw new CliError(
          "validation_error",
          "--from-dir needs --chat and cannot be combined with --download or --output-dir",
        )
      if (download && outputDir === undefined)
        throw new CliError("validation_error", "--download saves the files first: name the folder with --output-dir")
      if (outputDir !== undefined && !download)
        throw new CliError("validation_error", "--output-dir is where --download saves; add --download")
      const stop = stopOnSignal(this)
      const deadline = new AbortController()
      context.track({ close: async () => deadline.abort() })
      const environment = environmentOf(this)
      const signal = AbortSignal.any([
        stop.signal,
        deadline.signal,
        ...[environment.signal, environment.commandSignal].filter((one): one is AbortSignal => one !== undefined),
      ])
      try {
        const pipeline = ocr
          ? gatewayOcr({ app: messenger.app, settings: context.settings, env: context.env, enabled: true, signal })
          : undefined
        const run = await context.withServices((services) =>
          services.attachments.extract({
            ...(chat === undefined ? {} : { chat }),
            ...(limit === undefined ? {} : { limit }),
            ...(fromDir === undefined ? {} : { fromDir }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(download && outputDir !== undefined
              ? {
                  download: async (chatId, messageId) => {
                    await downloadMessage(services.messages, chatId, messageId, outputDir, context.renderer.warn)
                  },
                }
              : {}),
            signal,
            ...(pipeline === undefined ? {} : { ocr: pipeline, concurrency: concurrency ?? 4 }),
            onItem: (item) => {
              if (context.format === "pretty") context.streams.data(`${line(item)}\n`)
              else if (context.format === "jsonl") context.renderer.stream([item])
            },
          }),
        )
        for (const engine of run.enginesMissing) context.renderer.note(engineHint(engine, messenger.app.command))
        if (context.format === "json") context.renderer.result(run)
        else context.renderer.note(summary(run))
      } finally {
        stop.release()
      }
    })

const row = ({ locator, attachment, name, localPath, text }: AttachmentItem) =>
  `${locator} #${attachment}  ${name ?? ""}  ${text ? `${text.origin} ${text.chars}` : "no text"}  ${localPath ?? "not downloaded"}`

const listCommand = (messenger: Messenger): Command =>
  withPaging(
    new Command("list")
      .description("files of stored messages, where each was saved and whether its text is held — never the text")
      .option("--chat <chat>", `only this chat's files; ${messenger.chatArgument}`)
      .option("--needs-text", "only files saved here whose text nobody has yet: what an agent reads and writes back"),
  ).action(async function (this: Command) {
    const context = messengerContext(this, messenger)
    const { chat, needsText } = this.opts<{ chat?: string; needsText?: boolean }>()
    const { limit = Number.MAX_SAFE_INTEGER - 1, offset } = window(context.settings)
    const page = context.settings.all ? 1 : offset / limit + 1
    const found = await context.withServices((services) =>
      services.attachments.list({
        ...(chat === undefined ? {} : { chat }),
        ...(needsText ? { needsText } : {}),
        limit,
        page,
      }),
    )
    renderPage(context, { items: found.slice(0, limit), hasMore: found.length > limit }, (items) =>
      items.length === 0 ? "" : `${items.map(row).join("\n")}\n`,
    )
  })

const showCommand = (messenger: Messenger): Command =>
  new Command("show")
    .description("read a bounded chunk of one retained attachment; JSON includes base64 bytes")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator alone`)
    .argument("[message]", "the message id")
    .option("--attachment <n>", "file position from 1; required for several files", count)
    .option("--page <n>", "render one PDF page as PNG, from 1; optional unpdf/canvas, no OCR", Number)
    .option("--offset-bytes <n>", "byte offset from 0", Number)
    .option("--chunk-bytes <n>", "bytes to return, 1–1048576 (default524288)", Number)
    .option("--if-sha256 <hash>", "require the whole file SHA-256 from the preceding chunk")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        attachment?: number
        page?: number
        offsetBytes?: number
        chunkBytes?: number
        ifSha256?: string
      }>()
      const stop = stopOnSignal(this)
      try {
        const done = await context.withServices((services) =>
          services.attachments.show({
            chat,
            ...(message === undefined ? {} : { message }),
            ...options,
            signal: AbortSignal.any([
              stop.signal,
              ...[environmentOf(this).signal, environmentOf(this).commandSignal].filter(
                (one): one is AbortSignal => one !== undefined,
              ),
            ]),
          }),
        )
        if (context.format === "pretty")
          context.streams.data(
            done.locator +
              " #" +
              done.attachment +
              "  " +
              done.readBytes +
              "/" +
              done.totalBytes +
              " bytes  SHA-256 " +
              done.sha256 +
              "\n",
          )
        else context.renderer.result(done)
      } finally {
        stop.release()
      }
    })

const textCommand = (messenger: Messenger): Command => {
  const text = new Command("text").description("the text of one file, as an agent read it")
  text
    .command("set")
    .description("keep the text an agent read from a file — a scan, a photo — so content: finds it; nothing is sent")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option("--attachment <n>", "which file of the message, from 1; needed when it has more than one", count)
    .option("--text-file <path>", "read the text from this file; - or none reads stdin")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "attachments.text.set")
      const { attachment, textFile } = this.opts<{ attachment?: number; textFile?: string }>()
      const given =
        textFile === undefined || textFile === "-" ? await readAll(context.stdin) : readFileSync(textFile, "utf8")
      const done = await context.withServices((services) =>
        services.attachments.setText({
          chat,
          ...(message === undefined ? {} : { message }),
          ...(attachment === undefined ? {} : { attachment }),
          text: given,
        }),
      )
      if (context.format === "pretty")
        context.streams.data(`${done.locator} #${done.attachment}  ${done.chars} characters kept\n`)
      else context.renderer.result(done)
    })
  return text
}

/** Files of stored messages: what is in them, for `content:` in a search. Nothing here is sent. */
export const attachmentsCommand = (messenger: Messenger): Command =>
  new Command("attachments")
    .description("the files of stored messages: their text in the local store, for content: in a search")
    .addCommand(extractCommand(messenger))
    .addCommand(listCommand(messenger))
    .addCommand(showCommand(messenger))
    .addCommand(textCommand(messenger))
