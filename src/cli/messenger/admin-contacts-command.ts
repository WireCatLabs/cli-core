import { readFile } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { PhoneBookEntry } from "../../domain/models.js"
import { phoneOf } from "../../services/index.js"
import { REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"

const PERSON = "person id — `contacts lookup` finds one — or part of a known name"

/** The address book's writes, in max-cli's words. */
export const contactWriteCommands = (messenger: Messenger): Command[] => {
  const simple = (
    [
      ["add", "add a person to your contacts — `contacts list` still shows only people you have a dialog with"],
      ["remove", "remove a person from your contacts; the chat stays, a name you gave them may not"],
      ["block", "stop a person from writing to you — they need not be a contact"],
      ["unblock", "let a blocked person write to you again"],
    ] as const
  ).map(([name, description]) =>
    annotate(new Command(name), { effects: REMOTE_WRITE })
      .description(description)
      .argument("<person>", PERSON)
      .action(async function (this: Command, person: string) {
        const context = messengerContext(this, messenger)
        const done = await context.withServices((services): Promise<object> => services.people[name](person))
        renderAnswer(this, context, itemOf(snakeKeys(done)))
      }),
  )

  const rename = annotate(new Command("rename"), { effects: REMOTE_WRITE })
    .description("rename the contact in the messenger address book; use contacts alias for a private local name")
    .argument("<person>", PERSON)
    .argument("<first-name>", "the name you want to see for them")
    .argument("[last-name]")
    .action(async function (this: Command, person: string, firstName: string, lastName?: string) {
      const context = messengerContext(this, messenger)
      const renamed = await context.withServices((services) => services.people.rename(person, firstName, lastName))
      renderAnswer(this, context, itemOf(snakeKeys(renamed)))
    })

  /** A file rather than argv: these are phone numbers, and argv is read by `ps` and kept by the shell. */
  const importing = annotate(new Command("import"), { effects: REMOTE_WRITE })
    .description("upload phone numbers and add the people the messenger has under them")
    .argument("<file>", "one person per line: number, then a comma, a tab or a semicolon, then the name")
    .action(async function (this: Command, file: string) {
      const context = messengerContext(this, messenger)
      const entries = phoneBook(
        await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          throw new CliError("not_found", `cannot read ${file}: ${error.code ?? error.message}`)
        }),
      )
      const imported = await context.withServices((services) => services.people.import(entries))
      renderAnswer(this, context, itemOf(snakeKeys(imported)))
      context.renderer.success(`${imported.sent} sent, ${imported.recognised.length} recognised`)
    })

  return [...simple, rename, importing]
}

/** ⚠ A bad line is named by its number, never by what is on it. */
export const phoneBook = (text: string): PhoneBookEntry[] =>
  text.split(/\r?\n/).flatMap((line, index) => {
    if (line.trim() === "") return []
    const match = /^\s*([^,\t;]+?)\s*[,\t;]\s*(.*\S)\s*$/.exec(line)
    if (!match?.[1] || !match[2]) throw new CliError("validation_error", `line ${index + 1} is not "number, name"`)
    try {
      return [{ phone: phoneOf(match[1]), name: match[2] }]
    } catch {
      throw new CliError("validation_error", `line ${index + 1}: the number is not a phone number with a country code`)
    }
  })
