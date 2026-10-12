import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import type { Id } from "../../domain/models.js"
import { toMarkdown } from "../../render/markdown.js"
import { renderMessages } from "../../render/messages.js"
import { seal } from "../../sealed.js"
import { CHAT_KINDS } from "../../services/chats.js"
import { kindsOf } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { renderList } from "../paging.js"
import { fetchCommand, jobsCommand } from "./backfill-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { admitPassword, linesOf, openFolder, runFileFor, saveManifest, sealRun, writeChanges } from "./export-folder.js"
import { gapsCommand } from "./gaps-command.js"
import { ENCRYPT_OPTION, passwordOf } from "./password.js"
import { storeMaintenanceCommands } from "./store-maintenance-command.js"

/** `store`: the local store of messages — what it holds, filling it, reading it out, and looking after the file. */
export const storeCommand = (messenger: Messenger): Command => {
  const store = new Command("store")
    .description("the local store of messages")
    .addCommand(statusCommand(messenger))
    .addCommand(fetchCommand(messenger))
    .addCommand(gapsCommand(messenger))
    .addCommand(jobsCommand(messenger))
    .addCommand(exportCommand(messenger))
    .addCommand(clearCommand(messenger))
  for (const command of storeMaintenanceCommands(messenger)) store.addCommand(command)
  return store
}

/**
 * What the local store holds, per chat — read from the store alone. Whether a fetch reached a
 * chat's very first message is not recorded, so it is not claimed: the stretches held are shown.
 */
const statusCommand = (messenger: Messenger): Command =>
  new Command("status")
    .description("per chat: messages stored, the oldest and newest, and the stretches held completely")
    .argument("[chat]", messenger.chatArgument)
    .action(async function (this: Command, chat: string | undefined) {
      const context = messengerContext(this, messenger)
      const rows = await context.withServices((services) => services.archive.status(chat))
      renderList(context.renderer, context.format, rows)
      if (rows.length === 0) context.renderer.note("the store holds no messages for this profile yet")
    })

/**
 * Deletes from the store, which is the archive: only what `--left` names, and only with
 * `--allow-dangerous`, since a chat the account left cannot be fetched again. Emptying the whole
 * store is not offered.
 */
const clearCommand = (messenger: Messenger): Command =>
  new Command("clear")
    .description("delete from the store the chats this account has left, with their messages")
    .option("--left", "the chats this account has left — the only thing this clears")
    .option("--allow-dangerous", "yes, delete — it cannot be undone, and a chat you left cannot be fetched again")
    .action(async function (this: Command) {
      const { left, allowDangerous } = this.opts<{ left?: boolean; allowDangerous?: boolean }>()
      if (!left) {
        throw new CliError(
          "validation_error",
          "say what to clear: --left, the chats this account has left — emptying the whole store is not offered",
        )
      }
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.archive.left())
      if (found.chats > 0 && !allowDangerous) {
        throw new CliError(
          "confirmation_required",
          `this deletes ${found.chats} chat(s) this account has left and their ${found.messages} message(s) ` +
            "from the store, and it cannot be undone — add --allow-dangerous to go ahead",
        )
      }
      const cleared =
        found.chats > 0 ? await context.withServices((services) => services.archive.left({ clear: true })) : found
      context.renderer.result({ cleared: cleared.chats > 0, ...cleared })
      if (cleared.chats === 0) context.renderer.note("the store holds no chats this account has left")
      else context.renderer.success(`deleted ${cleared.chats} chat(s) and ${cleared.messages} message(s)`)
    })

/**
 * One chat's stored messages, oldest first — `--jsonl` for a file or a pipe, one message per line,
 * `--format markdown` for a transcript a person reads. With `--to`, any number of chats into a
 * folder, and each later run into the same folder adds only what changed.
 */
const exportCommand = (messenger: Messenger): Command =>
  new Command("export")
    .description(
      "a chat's stored messages, oldest first: --jsonl one message per line, --json one { items } object; never asks the messenger",
    )
    .argument("[chats...]", `${messenger.chatArgument}; several with --to`)
    .option(
      "--format <format>",
      "jsonl: one message per line, the default with --output; markdown: a transcript with a heading per day, replies and forwards quoted",
    )
    .option("--since-time <time>", "only from this ISO 8601 time, or 30m / 2h / 1d ago, on")
    .option("--output <file>", "write JSON lines, or the transcript, to this new file, readable only by you")
    .option(
      "--to <dir>",
      "write into this folder, a file per chat and a manifest; run again on it for only what changed since",
    )
    .option("--kind <kinds>", `with --to: every stored chat of these kinds, comma-separated: ${CHAT_KINDS.join(", ")}`)
    .option("--all", "with --to: every stored chat of this account")
    .option(...ENCRYPT_OPTION)
    .action(async function (this: Command, chats: string[]) {
      const {
        format,
        sinceTime: since,
        output,
        to,
        kind,
        all,
        encrypt,
      } = this.opts<{
        format?: string
        sinceTime?: string
        output?: string
        to?: string
        kind?: string
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
            "--to writes JSON lines and keeps its own point — not with --format markdown, --since-time or --output",
          )
        }
        if (chats.length === 0 && kind === undefined && all !== true) {
          throw new CliError("validation_error", "--to needs chats, --kind or --all")
        }
        const kinds = kind === undefined ? undefined : kindsOf(kind)
        const dir = resolve(to)
        const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
        context.renderer.result(
          await context.withServices(async (services) => {
            const { account, chats: chosen } = await services.archive.exportable({
              chats,
              ...(kinds === undefined ? {} : { kinds }),
            })
            const manifest = openFolder(dir, account, password !== undefined)
            if (password !== undefined) await admitPassword(manifest, password)
            const run = runFileFor(new Date().toISOString())
            const written: { id: Id; title: string | null; file: string | null; messages: number; deleted: number }[] =
              []
            const exportChat = async function* ({ id, title: named }: { id: Id; title: string | null }) {
              const title = password === undefined ? named : null
              const before = manifest.chats[id]
              const changes = await services.archive.changes(id, before?.mark)
              const empty = changes.messages.length === 0 && changes.deleted.length === 0
              let file: string | null = null
              if (password !== undefined) {
                yield* linesOf(id, changes)
                if (!empty) file = run
              } else if (before === undefined || !empty) file = writeChanges(dir, id, changes.mark, changes)
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
          }),
        )
        return
      }
      if (chats.length !== 1 || kind !== undefined || all === true) {
        throw new CliError("validation_error", "one chat at a time without --to; --kind and --all need --to")
      }
      if (encrypt && output === undefined) {
        throw new CliError("validation_error", "--encrypt writes a file — with --output or --to")
      }
      const password = encrypt ? await passwordOf(this, { twice: true }) : undefined
      const chat = chats[0] as string
      const from = since === undefined ? undefined : new Date(momentOf(since, "--since-time")).toISOString()
      const { title, messages } = await context.withServices((services) =>
        services.archive.export(chat, from === undefined ? {} : { since: from }),
      )
      if (output !== undefined) {
        const path = resolve(output)
        const body =
          format === "markdown"
            ? toMarkdown(title, messages)
            : messages.map((message) => `${JSON.stringify(message)}\n`).join("")
        try {
          if (password !== undefined) await seal(() => Readable.from([body]), path, password)
          else writeFileSync(path, body, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new CliError("validation_error", `${path} exists — an export never overwrites a file`)
          throw error
        }
        context.renderer.result({
          path,
          format: format ?? "jsonl",
          count: messages.length,
          ...(password === undefined ? {} : { encrypted: true }),
        })
        return
      }
      if (format === "markdown") context.streams.data(toMarkdown(title, messages).replace(/\n$/, ""))
      else if (format === "jsonl" || context.format === "jsonl")
        for (const message of messages) context.streams.data(JSON.stringify(message))
      else if (context.format === "json") context.renderer.result({ items: messages })
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
