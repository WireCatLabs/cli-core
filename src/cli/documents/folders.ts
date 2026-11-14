import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { honoursDryRun } from "../dry-run-guard.js"
import { FETCH, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { type Body, itemOf } from "../envelope.js"
import { bindQuery, documentQueries, folderRow, termsOf } from "./queries.js"
import { allOf, type DocumentWords, examples, wordsOf } from "./words.js"

export interface DocumentFolderCommands {
  words: DocumentWords
  output(body: Body): void
  /** Checks the folder with the provider and keeps it in the selected profile; refuses one that is not a folder. */
  add(input: string): Promise<{ id: string; name: string }>
  /** The selected profile's chosen folders, narrowed by `id:`. */
  list(filter: Record<string, string>): { id: string }[]
  /** Forgets the folder; answers its id. */
  remove(input: string): string
  /** Adds the CLI's own `folders browse`, which help then lists between `list` and `remove`. */
  browse?(folders: Command): void
}

const addDocumentFolderCommandsDefinition = (program: Command, helpers: DocumentFolderCommands) => {
  const { output } = helpers
  const wording = wordsOf(helpers.words)
  const { prefix, text } = wording
  const queries = documentQueries()
  const folders = annotate(program.command("folders"), { effects: LOCAL_READ }).description(text.folders)
  examples(
    annotate(folders.command("add"), { effects: FETCH })
      .argument("<folder>", text.folderArgument)
      .description("import a folder and everything under it on the next sync"),
    [`${prefix} folders add FOLDER_ID`],
  ).action(async (input: string) => {
    const { id, name } = await helpers.add(input)
    output(itemOf({ id, name, added: true }))
  })
  bindQuery(
    examples(
      annotate(folders.command("list"), { effects: LOCAL_READ }).description("list the folder ids sync imports"),
      [`${prefix} folders list`],
    ),
    queries.folders,
    folderRow,
  ).action((words: string[]) => {
    const filter = termsOf(words, queries.folders, "folders list")
    output(allOf(helpers.list(filter)))
  })
  examples(
    annotate(folders.command("remove"), { effects: LOCAL_WRITE })
      .argument("<folder>", text.folderArgument)
      .description("stop importing a folder; the next sync drops its documents"),
    [`${prefix} folders remove FOLDER_ID`],
  ).action((input: string) => {
    output(itemOf({ id: helpers.remove(input), removed: true }))
  })
  return folders
}

const sharedFolderCommands = honoursDryRun(sharedCommand(addDocumentFolderCommandsDefinition))

/** `folders add|list|remove`: the folders the selected profile's sync imports. */
export const addDocumentFolderCommands = (program: Command, helpers: DocumentFolderCommands): Command => {
  const folders = sharedFolderCommands(program, helpers)
  if (!helpers.browse) return folders
  const before = new Set(folders.commands)
  helpers.browse(folders)
  // The CLI's own command stays outside the shared contract, so it is added after it is taken, then put in its place.
  const added = folders.commands.filter((command) => !before.has(command))
  const children = folders.commands as Command[]
  const rest = children.filter((command) => before.has(command))
  const at = rest.findIndex((command) => command.name() === "remove")
  children.splice(0, children.length, ...rest.slice(0, at), ...added, ...rest.slice(at))
  return folders
}
