import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { CliError, singleLine } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import { toMarkdown } from "../../render/markdown.js"
import { renderMessages } from "../../render/messages.js"
import { seal } from "../../sealed.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { kindsOf } from "../../services/inbox.js"
import { dateWindow } from "../../services/moment.js"
import type { LeftChat } from "../../store/chats.js"
import { destroysNothing, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { commandAt, lineOf } from "../steps.js"
import { jobsCommand } from "./backfill-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { admitPassword, linesOf, openFolder, runFileFor, saveManifest, sealRun, writeChanges } from "./export-folder.js"
import { gapsCommand } from "./gaps-command.js"
import { historyLimitGaps } from "./history-gaps.js"
import { messageItems } from "./message-items.js"
import { ENCRYPT_OPTION, passwordOf } from "./password.js"
import { storeMaintenanceCommands } from "./store-maintenance-command.js"

/** `store`: the local store of messages — what it holds, filling it, reading it out, and looking after the file. */
export const storeCommand = (messenger: Messenger): Command => {
  const store = new Command("store")
    .description("the local store of messages")
    .addCommand(statusCommand(messenger))
    .addCommand(gapsCommand(messenger))
    .addCommand(jobsCommand(messenger))
    .addCommand(exportCommand(messenger))
    .addCommand(clearCommand(messenger))
  for (const command of storeMaintenanceCommands(messenger)) store.addCommand(command)
  const examples: Record<string, string> = {
    backup: "./backup.db",
    check: "",
    clear: "--left --dry-run",
    "copies delete": "messages_copy_1",
    decrypt: "./backup.enc --output ./restored.db",
    export: '"Book club" --output ./messages.jsonl',
    "gaps show": '"Book club"',
    "gaps repair": '"Book club" --limit 100',
    info: "",
    "jobs cancel": "job-101",
    "jobs clear": "",
    "jobs list": "",
    "jobs retry": "--failed",
    "jobs show": "",
    migrate: "",
    rebuild: "",
    repair: "--dry-run",
    reset: "",
    restore: "./backup.db",
    status: '"Book club"',
  }
  for (const [path, args] of Object.entries(examples)) {
    const command = commandAt(store, path)
    if (command) annotate(command, { examples: [`${messenger.app.command} personal store ${path} ${args}`.trimEnd()] })
  }
  return store
}

/**
 * What the local store holds, per chat — read from the store alone. Whether a fetch reached a
 * chat's very first message is not recorded, so it is not claimed: the stretches held are shown.
 */
const statusCommand = (messenger: Messenger): Command =>
  annotate(new Command("status"), { output: { entity: "store_chat_status" }, effects: LOCAL_READ })
    .summary("what the local archive holds and what is missing")
    .description("per chat: messages stored, the oldest and newest, and the stretches held completely")
    .argument("[chat]", messenger.chatArgument)
    .action(async function (this: Command, chat: string | undefined) {
      const context = messengerContext(this, messenger)
      const rows = await context.withServices((services) => services.archive.status(chat))
      const skips = await context
        .withStore((store, account) => store.chats.historySkips(account))
        .then((all) =>
          chat === undefined ? all : all.filter((skip) => rows.some((row) => row.chatId === skip.chatId)),
        )
        .catch(() => [])
      const limited = historyLimitGaps(skips)
      renderAnswer(
        this,
        context,
        listOf("store status", {
          items: rows.map(snakeKeys),
          limit: Math.max(1, rows.length),
          has_more: false,
          next: limited.next,
          missing: limited.missing,
        }),
      )
      if (rows.length === 0 && context.format === "pretty")
        context.renderer.note("the store holds no messages for this profile yet")
      if (skips.length > 0 && context.format === "pretty")
        context.renderer.note(
          `history limits left out pushed history of ${skips.length} chats — \`${lineOf(this, "messages sync <chat> --full-history")}\` fetches one and keeps it in full:\n` +
            skips
              .slice(0, 20)
              .map((skip) => `  ${skip.title ?? skip.chatId}  ${skip.messages} messages  ${skip.reason}`)
              .join("\n"),
        )
    })

const LISTED = 20

/** Titles are the owner's: these lines go to a person's terminal, never into an error message. */
const leftLines = (left: LeftChat[]): string[] => {
  const shown = left.slice(0, LISTED)
  const width = shown.reduce((widest, { id }) => Math.max(widest, id.length), 0)
  return [
    ...shown.map(
      ({ id, title, messages }) =>
        `  ${id.padEnd(width)}  ${title === null ? "(no title)" : singleLine(title)}  ${messages}`,
    ),
    ...(left.length > shown.length
      ? [`  and ${left.length - shown.length} more — --dry-run --json lists every one`]
      : []),
  ]
}

/**
 * Deletes from the store, which is the archive: only what `--left` names, and only with
 * `--allow-dangerous`, since a chat the account left cannot be fetched again. Emptying the whole
 * store is not offered. The refusal names the chats to a person but keeps them out of its message,
 * which a scheduled run's `last.json` keeps.
 */
const clearCommand = (messenger: Messenger): Command =>
  annotate(new Command("clear"), { output: { entity: "store_clear" }, effects: LOCAL_WRITE })
    .description("delete from the store the chats this account has left, with their messages")
    .option("--left", "the chats this account has left — the only thing this clears")
    .option("--allow-dangerous", "yes, delete — it cannot be undone, and a chat you left cannot be fetched again")
    .option("--dry-run", "list the chats it would delete, and delete nothing")
    .action(async function (this: Command) {
      const { left, allowDangerous, dryRun } = this.opts<{
        left?: boolean
        allowDangerous?: boolean
        dryRun?: boolean
      }>()
      if (!left) {
        throw new CliError(
          "validation_error",
          "say what to clear: --left, the chats this account has left — emptying the whole store is not offered",
        )
      }
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.archive.left())
      const pretty = context.format === "pretty"
      if (dryRun) {
        renderAnswer(this, context, itemOf(snakeKeys({ cleared: false, dryRun: true, ...found })))
        return
      }
      if (found.chats > 0 && !allowDangerous) {
        // Not a note: --quiet drops notes, and this list is what the owner confirms.
        if (pretty)
          for (const line of ["it would delete these chats — id, title, messages:", ...leftLines(found.left)])
            context.streams.diagnostic(line)
        throw new CliError(
          "confirmation_required",
          `this deletes ${found.chats} chat(s) this account has left and their ${found.messages} message(s) ` +
            "from the store, and it cannot be undone — --dry-run lists them; add --allow-dangerous to go ahead",
        )
      }
      const cleared =
        found.chats > 0 ? await context.withServices((services) => services.archive.left({ clear: true })) : found
      renderAnswer(this, context, itemOf(snakeKeys({ cleared: cleared.chats > 0, ...cleared })))
      if (!pretty) return
      if (cleared.chats === 0) context.renderer.note("the store holds no chats this account has left")
      else context.renderer.success(`deleted ${cleared.chats} chat(s) and ${cleared.messages} message(s)`)
    })

/**
 * One chat's stored messages, oldest first — `--jsonl` for a file or a pipe, one message per line,
 * `--format markdown` for a transcript a person reads. With `--output-dir`, any number of chats into a
 * folder, and each later run into the same folder adds only what changed.
 */
const exportCommand = (messenger: Messenger): Command =>
  destroysNothing(annotate(new Command("export"), { output: { entity: "store_export" }, effects: LOCAL_WRITE }))
    .summary("export stored messages to files")
    .description(
      "a chat's stored messages, oldest first: --jsonl one message per line, --json the list envelope of messages; never asks the messenger",
    )
    .argument("[chat...]", `${messenger.chatArgument}; several with --output-dir`)
    .option(
      "--format <format>",
      "jsonl: one message per line, the default with --output; markdown: a transcript with a heading per day, replies and forwards quoted",
    )
    .option("--since-time <time>", "only from this ISO 8601 time, or 30m / 2h / 1d ago, on")
    .option("--output <file>", "write JSON lines, or the transcript, to this new file, readable only by you")
    .option(
      "--output-dir <dir>",
      "write into this folder, a file per chat and a manifest; run again on it for only what changed since",
    )
    .option(
      "--include <kinds>",
      `with --output-dir: every stored chat of these kinds, comma-separated: ${CHAT_KINDS.join(", ")}`,
    )
    .option("--all", "with --output-dir: every stored chat of this account")
    .option(...ENCRYPT_OPTION)
    .action(async function (this: Command, chats: string[]) {
      const {
        format,
        sinceTime: since,
        output,
        outputDir: to,
        include: kind,
        all,
        encrypt,
      } = this.opts<{
        format?: string
        sinceTime?: string
        output?: string
        outputDir?: string
        include?: string
        all?: boolean
        encrypt?: boolean
      }>()
      if (format !== undefined && format !== "markdown" && format !== "jsonl") {
        throw new CliError("validation_error", `--format is jsonl or markdown, not "${format}"`)
      }
      const context = messengerContext(this, messenger)
      if (to !== undefined) {
        if (format === "markdown" || since !== undefined || output !== undefined) {
          throw new CliError(
            "validation_error",
            "--output-dir writes JSON lines and keeps its own point — not with --format markdown, --since-time or --output",
          )
        }
        if (chats.length === 0 && kind === undefined && all !== true) {
          throw new CliError("validation_error", "--output-dir needs chats, --include or --all")
        }
        const kinds = kind === undefined ? undefined : kindsOf(kind, "--include")
        const dir = resolve(to)
        const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
        const exported = await context.withServices(async (services) => {
          const { account, chats: chosen } = await services.archive.exportable({
            chats,
            ...(kinds === undefined ? {} : { kinds }),
          })
          const manifest = openFolder(dir, account, password !== undefined)
          if (password !== undefined) await admitPassword(manifest, password)
          const run = runFileFor(new Date().toISOString())
          const written: { id: Id; title: string | null; file: string | null; messages: number; deleted: number }[] = []
          const exportChat = async function* ({ id, title: named }: { id: Id; title: string | null }) {
            const title = password === undefined ? named : null
            const before = manifest.chats[id]
            const changes = await services.archive.changes(id, before?.mark)
            const empty = changes.messages.length === 0 && changes.deleted.length === 0
            let file: string | null = null
            if (password !== undefined) {
              yield* linesOf(id, changes, account)
              if (!empty) file = run
            } else if (before === undefined || !empty) file = writeChanges(dir, id, changes.mark, changes, account)
            manifest.chats[id] = {
              title,
              mark: changes.mark,
              files: [...(before?.files ?? []), ...(file === null ? [] : [file])],
              messages: (before?.messages ?? 0) + changes.messages.length,
              deleted: (before?.deleted ?? 0) + changes.deleted.length,
            }
            written.push({ id, title, file, messages: changes.messages.length, deleted: changes.deleted.length })
          }
          const everyChat = async function* () {
            for (const chat of chosen) yield* exportChat(chat)
          }
          if (password !== undefined) await sealRun(dir, run, everyChat(), password)
          // Unsealed, each chat is written as it is read; nothing is yielded, the walk is the work.
          else for await (const _ of everyChat()) void _
          saveManifest(dir, manifest)
          return { path: dir, ...(password === undefined ? {} : { encrypted: true }), chats: written }
        })
        renderAnswer(this, context, itemOf(snakeKeys(exported)))
        return
      }
      if (chats.length !== 1 || kind !== undefined || all === true) {
        throw new CliError(
          "validation_error",
          "one chat at a time without --output-dir; --include and --all need --output-dir",
        )
      }
      if (encrypt && output === undefined) {
        throw new CliError("validation_error", "--encrypt writes a file — with --output or --output-dir")
      }
      const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
      const chat = chats[0] as string
      const window = dateWindow(since === undefined ? {} : { sinceTime: since })
      const from = window.since === undefined ? undefined : new Date(window.since).toISOString()
      const { account, title, messages } = await context.withServices((services) =>
        services.archive.export(chat, from === undefined ? {} : { since: from }),
      )
      if (output !== undefined) {
        const path = resolve(output)
        const body =
          format === "markdown"
            ? toMarkdown(title, messages)
            : messageItems(messages, account)
                .map((item) => `${JSON.stringify(item)}\n`)
                .join("")
        try {
          if (password !== undefined) await seal(() => Readable.from([body]), path, password)
          else writeFileSync(path, body, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new CliError("validation_error", `${path} exists — an export never overwrites a file`)
          throw error
        }
        renderAnswer(
          this,
          context,
          itemOf(
            {
              path,
              format: format ?? "jsonl",
              count: messages.length,
              ...(password === undefined ? {} : { encrypted: true }),
            },
            { meta: window.meta },
          ),
        )
        return
      }
      if (format === "markdown") context.streams.data(toMarkdown(title, messages).replace(/\n$/, ""))
      else if (format === "jsonl" || context.format === "jsonl")
        for (const item of messageItems(messages, account)) context.streams.data(JSON.stringify(item))
      else if (context.format === "json")
        renderAnswer(
          this,
          context,
          listOf("store export", {
            items: messageItems(messages, account),
            limit: Math.max(1, messages.length),
            has_more: false,
            meta: window.meta,
          }),
        )
      else
        context.streams.data(
          renderMessages(messages, {
            color: context.color,
            verbosity: context.settings.detail,
            senderColors: context.settings.senderColors,
            profile: context.profile,
            provider: messenger.provider,
            locale: messenger.app.locale,
          }),
        )
      context.renderer.note(`${messages.length} messages`)
    })
