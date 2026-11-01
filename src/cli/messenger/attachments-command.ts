import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { engineHint } from "../../attachments/extract.js"
import { gatewayOcr } from "../../attachments/gateway-ocr.js"
import { refusedPlace } from "../../sends/upload.js"
import { ATTACHMENT_QUERY, type AttachmentItem, type ExtractItem, type ExtractRun } from "../../services/attachments.js"
import { downloadMessage } from "../../services/file-download.js"
import { environmentOf } from "../context.js"
import { FETCH, LOCAL_WRITE, ownerOnlyOption, REMOTE_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, withQuery } from "../list-query.js"
import { withPaging } from "../paging.js"
import { readsStdin } from "../stdin-field.js"
import { nextStep } from "../steps.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { addMediaArchiveCommands } from "./media-archive-command.js"
import { stopOnSignal } from "./patience.js"
import { readAll } from "./stdin.js"

export const count = (value: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("validation_error", `"${value}" is not a count`)
  return parsed
}

const line = ({ status, ref, attachment, name, chars }: ExtractItem) =>
  `${status}  ${ref} #${attachment}${name ? `  ${name}` : ""}${chars === undefined ? "" : `  (${chars} characters)`}`

const summary = (run: ExtractRun) =>
  [
    `${run.extracted} extracted`,
    run.needsAgent ? `${run.needsAgent} for an agent to read (attachments update)` : "",
    run.failed ? `${run.failed} unreadable` : "",
    run.unchanged ? `${run.unchanged} unchanged` : "",
    run.notDownloaded ? `${run.notDownloaded} not downloaded (--download)` : "",
    run.complete ? "" : "run it again to continue",
  ]
    .filter(Boolean)
    .join(", ")

const extractCommand = (messenger: Messenger): Command =>
  annotate(new Command("extract"), {
    output: { entity: "attachment_extraction" },
    effects: FETCH,
    examples: [`${messenger.app.command} personal attachments extract --chat "Book club" --limit 10`],
  })
    .summary("extract text from retained message files")
    .description(
      "read the text of downloaded files — text, PDF/DOCX text layers, ODT/ODS/XLSX/PPTX/EPUB — into the local store, where search finds them",
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
      if (outputDir !== undefined && refusedPlace(outputDir, messenger.app, context.env))
        throw new CliError(
          "validation_error",
          "--output-dir cannot write credential folders, the CLI's own folders or the message store",
        )
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
          ? gatewayOcr({
              app: messenger.app,
              settings: context.settings,
              env: context.env,
              keyring: context.keyring,
              enabled: true,
              signal,
            })
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
              else if (context.format === "jsonl") context.renderer.stream([snakeKeys(item)])
            },
          }),
        )
        const { items, ...totals } = run
        const next =
          run.cursor === undefined
            ? []
            : [
                nextStep("attachments.extract", {
                  args: { cursor: run.cursor, ...(chat === undefined ? {} : { chat }) },
                }),
              ]
        for (const engine of run.enginesMissing) context.renderer.note(engineHint(engine, messenger.app.command))
        if (context.format === "json")
          renderAnswer(this, context, itemOf(snakeKeys({ ...totals, files: items }), { next }))
        else context.renderer.note(summary(run))
      } finally {
        stop.release()
      }
    })

const row = ({ message, position, name, local_path, extraction }: AttachmentItem) =>
  `${message} #${position}  ${name ?? ""}  ${extraction ? `${extraction.origin} ${extraction.chars}` : "no text"}  ` +
  (local_path ?? "not downloaded")

const listCommand = (messenger: Messenger): Command =>
  withQuery(
    withPaging(
      annotate(new Command("list"), {
        effects: REMOTE_READ,
        examples: [`${messenger.app.command} personal attachments list --limit 10`],
      })
        .summary("stored message files, saved paths and text status")
        .description(
          "files of stored messages, newest first: where each was saved and whether its text is held — never the text",
        ),
    ),
    ATTACHMENT_QUERY,
  ).action(async function (this: Command, words: string[]) {
    const context = messengerContext(this, messenger)
    const query = listQuery(typedQuery(words), ATTACHMENT_QUERY, "attachments list")
    const found = await context.withServices((services) =>
      services.attachments.list({ ...pageOf(context.settings), ...(query ? { query } : {}) }),
    )
    renderAnswer(this, context, pagedList("attachments list", context.settings, found), () =>
      found.items.length === 0 ? "" : `${found.items.map(row).join("\n")}\n`,
    )
  })

const showCommand = (messenger: Messenger): Command =>
  annotate(new Command("show"), {
    output: { entity: "attachment_bytes" },
    effects: REMOTE_READ,
    examples: [`${messenger.app.command} personal attachments show "Book club" 101 --attachment 1`],
  })
    .description("read a bounded chunk of one retained attachment; JSON includes base64 bytes")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator alone`)
    .argument("[message]", "the message id")
    .option("--attachment <n>", "file position from 1; required for several files", count)
    .option("--page <n>", "render one PDF page as PNG, from 1; optional unpdf/canvas, no OCR", Number)
    .option("--offset-bytes <n>", "byte offset from 0", Number)
    .option("--chunk-bytes <n>", "bytes to return, 1–1048576 (default524288)", Number)
    .option("--expected-fingerprint <hash>", "require the whole file SHA-256 from the preceding chunk")
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      const { expectedFingerprint, ...options } = this.opts<{
        attachment?: number
        page?: number
        offsetBytes?: number
        chunkBytes?: number
        expectedFingerprint?: string
      }>()
      const stop = stopOnSignal(this)
      try {
        const done = await context.withServices((services) =>
          services.attachments.show({
            chat,
            ...(message === undefined ? {} : { message }),
            ...options,
            ...(expectedFingerprint === undefined ? {} : { ifSha256: expectedFingerprint }),
            signal: AbortSignal.any([
              stop.signal,
              ...[environmentOf(this).signal, environmentOf(this).commandSignal].filter(
                (one): one is AbortSignal => one !== undefined,
              ),
            ]),
          }),
        )
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(done)),
          () => `${done.ref} #${done.attachment}  ${done.readBytes}/${done.totalBytes} bytes  SHA-256 ${done.sha256}\n`,
        )
      } finally {
        stop.release()
      }
    })

const textUpdateCommand = (messenger: Messenger): Command => {
  const update = readsStdin(
    annotate(new Command("update"), {
      output: { entity: "attachment_text_change" },

      effects: LOCAL_WRITE,
      examples: [`${messenger.app.command} personal attachments update "Book club" 101 --text-file ./transcript.txt`],
    }),
    {
      name: "text",
      description: "the text of the file",
    },
  )
    .summary("save the text read from one message file")
    .description("keep the text an agent read from a file — a scan, a photo — so search finds it; nothing is sent")
    .argument("<chat>", `${messenger.chatArgument}; or a msg: locator, with no message id after it`)
    .argument("[message]", "the message id")
    .option("--attachment <n>", "which file of the message, from 1; needed when it has more than one", count)
    .addOption(ownerOnlyOption("--text-file <path>", "read the text from this file; - or none reads stdin"))
    .action(async function (this: Command, chat: string, message: string | undefined) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "attachments.update")
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
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(done)),
        () => `${done.ref} #${done.attachment}  ${done.chars} characters kept\n`,
      )
    })
  return update
}

/** Files of stored messages: what is in them, for `content:` in a search. Nothing here is sent. */
export const attachmentsCommand = (messenger: Messenger): Command => {
  const attachments = new Command("attachments")
    .summary("stored message files and their retained text")
    .description("the files of stored messages: their text in the local store, where search finds it")
    .addCommand(extractCommand(messenger))
    .addCommand(listCommand(messenger))
    .addCommand(showCommand(messenger))
    .addCommand(textUpdateCommand(messenger))
  addMediaArchiveCommands(attachments, messenger)
  return attachments
}
