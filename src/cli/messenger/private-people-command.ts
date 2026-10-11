import { readFile } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { listed } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { readAll } from "./stdin.js"

export const privatePeopleCommands = (messenger: Messenger): Command[] => {
  const alias = new Command("alias").description("a private local display name in the selected account")
  annotate(alias.command("set"), { mutates: true, local: true })
    .argument("<person>")
    .argument("<alias>")
    .action(async function (this: Command, person: string, value: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.alias.set")
      context.renderer.result(await context.withServices((services) => services.privatePeople.alias(person, value)))
    })
  annotate(alias.command("rm"), { mutates: true, local: true })
    .argument("<person>")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.alias.rm")
      context.renderer.result(await context.withServices((services) => services.privatePeople.alias(person, null)))
    })
  const notes = new Command("notes").description(
    "your private notes on a stored contact, the same in every account that sees them",
  )
  notes
    .command("list")
    .argument("<person>")
    .action(async function (this: Command, person: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        listed((await context.withServices((services) => services.privatePeople.show(person))).notes),
      )
    })
  notes
    .command("show")
    .argument("<person>")
    .argument("<id>")
    .action(async function (this: Command, person: string, id: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.privatePeople.note(person, id)))
    })
  for (const name of ["add", "edit"] as const) {
    const command = annotate(notes.command(name), { mutates: true, local: true })
      .argument("<person>")
      .option("--file <path>", "read note text from a file; omitted or - reads stdin")
    if (name === "edit")
      command.argument("<id>").requiredOption("--revision <number>", "the revision you read before editing")
    command.action(async function (this: Command, person: string, id?: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, `contacts.notes.${name}`)
      const { file, revision } = this.opts<{ file?: string; revision?: string }>()
      const text = file === undefined || file === "-" ? await readAll(context.stdin) : await readFile(file, "utf8")
      const version = Number(revision)
      if (name === "edit" && (!Number.isSafeInteger(version) || version < 1))
        throw new CliError("validation_error", "--revision is a positive integer")
      context.renderer.result(
        await context.withServices((services) =>
          name === "add"
            ? services.privatePeople.add(person, text)
            : services.privatePeople.edit(person, id as string, text, version),
        ),
      )
    })
  }
  annotate(notes.command("remove"), { mutates: true, local: true })
    .argument("<person>")
    .argument("<id>")
    .action(async function (this: Command, person: string, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "contacts.notes.remove")
      context.renderer.result(await context.withServices((services) => services.privatePeople.remove(person, id)))
    })
  return [alias, notes]
}
