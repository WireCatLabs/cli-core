import { readFile } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { contactNote } from "../../entities/index.js"
import type { ContactNoteItem } from "../../services/private-people.js"
import { LOCAL_READ, LOCAL_WRITE, ownerOnlyOption } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { readsStdin } from "../stdin-field.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { readAll } from "./stdin.js"

/** A contact's notes, all of them: a person has a handful, never a page. */
const NOTES_QUERY = unfilteredQuery("contact_note", contactNote)

const everyNote = (command: string, items: ContactNoteItem[]) =>
  listOf(command, { items, limit: Math.max(1, items.length), has_more: false })

export const privatePeopleCommands = (messenger: Messenger): Command[] => {
  const alias = new Command("alias").description("a private local display name in the selected account")
  annotate(alias.command("set"), { effects: LOCAL_WRITE })
    .argument("<person>")
    .argument("<alias>")
    .action(async function (this: Command, person: string, value: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.alias.set")
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.privatePeople.alias(person, value)))),
      )
    })
  annotate(alias.command("rm"), { effects: LOCAL_WRITE })
    .argument("<person>")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.alias.rm")
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.privatePeople.alias(person, null)))),
      )
    })
  const notes = new Command("notes").description(
    "your private notes on a stored contact, the same in every account that sees them",
  )
  withQuery(annotate(notes.command("list"), { effects: LOCAL_READ }).argument("<person>"), NOTES_QUERY).action(
    async function (this: Command, person: string, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), NOTES_QUERY, "contacts notes list")
      const items = await context.withServices((services) => services.privatePeople.notes(person))
      renderAnswer(this, context, everyNote("contacts notes list", items))
    },
  )
  annotate(notes.command("show"), { effects: LOCAL_READ, output: { entity: "contact_note" } })
    .argument("<person>")
    .argument("<id>")
    .action(async function (this: Command, person: string, id: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(await context.withServices((services) => services.privatePeople.note(person, id))),
      )
    })
  for (const name of ["add", "edit"] as const) {
    const command = readsStdin(
      annotate(notes.command(name), {
        effects: LOCAL_WRITE,
        output: { entity: "contact_note" },
      }),
      { name: "text", description: "the note's text" },
    )
      .argument("<person>")
      .addOption(ownerOnlyOption("--file <path>", "read note text from a file; omitted or - reads stdin"))
    if (name === "edit")
      command.argument("<id>").requiredOption("--revision <n>", "the revision you read before editing")
    command.action(async function (this: Command, person: string, id?: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, `contacts.notes.${name}`)
      const { file, revision } = this.opts<{ file?: string; revision?: string }>()
      const text = file === undefined || file === "-" ? await readAll(context.stdin) : await readFile(file, "utf8")
      const version = Number(revision)
      if (name === "edit" && (!Number.isSafeInteger(version) || version < 1))
        throw new CliError("validation_error", "--revision is a positive integer")
      const saved = await context.withServices((services) =>
        name === "add"
          ? services.privatePeople.add(person, text)
          : services.privatePeople.edit(person, id as string, text, version),
      )
      renderAnswer(this, context, itemOf(saved))
    })
  }
  annotate(notes.command("remove"), { effects: LOCAL_WRITE })
    .argument("<person>")
    .argument("<id>")
    .action(async function (this: Command, person: string, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.notes.remove")
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.privatePeople.remove(person, id)))),
      )
    })
  return [alias, notes]
}
