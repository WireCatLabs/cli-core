import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { TAG_TYPES, type TagType } from "../../domain/tags.js"
import type { TagTargetInput, TagTargetView } from "../../services/tags.js"
import type { StoredTag } from "../../store/store.js"
import { listed, positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const targetOptions = (command: Command, messenger: Messenger, verb: string): Command =>
  command
    .argument("<tag...>", "one or more tags: 1–32 letters a–z, digits and hyphens; upper case is lowered")
    .option("--chat <chat>", `the chat to ${verb}, or the chat of --message; ${messenger.chatArgument}`)
    .option("--contact <person>", `the person to ${verb}: their id, @username or name, as the local store knows them`)
    .option("--message <message>", `the message to ${verb}: its id in --chat, or a msg: locator alone`)

const describe = ({ type, chatId, personId, messageId }: TagTargetView) =>
  type === "chat"
    ? `chat ${chatId}`
    : type === "contact"
      ? `person ${personId}`
      : `message ${messageId} in chat ${chatId}`

const line = (one: StoredTag) => {
  const target =
    one.type === "contact"
      ? `${one.name ?? ""} (${one.personId})`
      : one.type === "chat"
        ? `${one.chatTitle ?? ""} (${one.chatId})`
        : `${one.locator}`
  return `${one.tag}  ${one.type}  ${target.trim()}`
}

const sourceOf = (value: string): "manual" | "auto" => {
  if (value !== "manual" && value !== "auto") throw new CliError("validation_error", "--source takes manual or auto")
  return value
}

const typeOf = (value: string): TagType => {
  if (!(TAG_TYPES as readonly string[]).includes(value))
    throw new CliError("validation_error", `--type takes ${TAG_TYPES.join(", ")}`)
  return value as TagType
}

/** The owner's labels, in the local store only: `tag:` in a search finds what they label. */
export const tagsCommand = (messenger: Messenger): Command => {
  const tags = new Command("tags").description(
    "your own labels on chats, people and messages, kept in the local store and never sent; tag: in a search finds them",
  )

  annotate(tags.command("auto"), { mutates: true, local: true })
    .description("derive local group/channel tags from cached metadata using keyword rules")
    .option(
      "--chat <chat>",
      "a stored group/channel; repeat to select several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--limit <number>", "process at most 1–500 chats", positiveCount("--limit"), 50)
    .option("--refresh-metadata", "read current descriptions from the messenger before classifying")
    .option("--dry-run", "preview cached classification without changing the store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat, limit, refreshMetadata, dryRun } = this.opts<{
        chat: string[]
        limit: number
        refreshMetadata?: boolean
        dryRun?: boolean
      }>()
      if (!dryRun) refuseLocalWrite(context, messenger.app.command, "tags.auto")
      context.renderer.result(
        await context.withServices((services) =>
          services.metadata.auto({ chats: chat, limit: Number(limit), refresh: refreshMetadata, dryRun }),
        ),
      )
    })

  targetOptions(
    annotate(tags.command("add"), { mutates: true, local: true }).description(
      "put tags on one chat, person or message",
    ),
    messenger,
    "tag",
  ).action(async function (this: Command, given: string[]) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tags.add")
    const target = this.opts<TagTargetInput>()
    const done = await context.withServices((services) => services.tags.add(target, given))
    if (context.format !== "pretty") return context.renderer.result(done)
    if (done.added.length) context.streams.data(`${describe(done.target)}: ${done.added.join(", ")}\n`)
    if (done.unchanged.length) context.renderer.note(`already there: ${done.unchanged.join(", ")}`)
  })

  targetOptions(
    annotate(tags.command("remove"), { mutates: true, local: true }).description(
      "take tags off one chat, person or message",
    ),
    messenger,
    "untag",
  )
    .option("--source <manual|auto>", "remove only this ownership claim", sourceOf)
    .action(async function (this: Command, given: string[]) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tags.remove")
      const target = this.opts<TagTargetInput>()
      const done = await context.withServices((services) =>
        services.tags.remove(target, given, this.opts<{ source?: "manual" | "auto" }>().source),
      )
      if (context.format !== "pretty") return context.renderer.result(done)
      if (done.removed.length) context.streams.data(`${describe(done.target)}: ${done.removed.join(", ")} removed\n`)
      if (done.unchanged.length) context.renderer.note(`not there: ${done.unchanged.join(", ")}`)
    })

  tags
    .command("list")
    .description("what is tagged: this account's chats and messages, and the people of its messenger")
    .option("--tag <tag>", "only this tag")
    .option("--source <manual|auto>", "only labels with this ownership claim", sourceOf)
    .option("--type <names>", "only what is tagged of this type: chat, contact or message", typeOf)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const filter = this.opts<{ tag?: string; type?: TagType; source?: "manual" | "auto" }>()
      const found = await context.withServices((services) => services.tags.list(filter))
      if (context.format === "jsonl") context.renderer.stream(found)
      else if (context.format !== "pretty") context.renderer.result(listed(found))
      else if (found.length === 0)
        context.renderer.note("nothing is tagged — `tags add <tag> --chat <chat>` tags a chat")
      else context.streams.data(`${found.map(line).join("\n")}\n`)
    })

  return tags
}
