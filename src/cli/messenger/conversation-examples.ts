import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { commandAt } from "../steps.js"

export const conversationExamples = (root: Command, tool: string): void => {
  const examples: Record<string, string> = {
    "batches show": '--chat "Book club"',
    "batches status": '--chat "Book club"',
    "links rebuild": '--chat "Book club"',
    "consents list": "",
    "consents remove": '--chat "Book club"',
    embed: '--chat "Book club"',
    "embeddings clear": '--chat "Book club"',
    "embeddings status": '--chat "Book club"',
    "links add": '--batch "$batch"',
    "links clear": '--chat "Book club"',
    list: '"Book club"',
    related: '"Book club" 101',
    show: '"Book club" 101',
    status: "",
  }
  for (const [path, args] of Object.entries(examples)) {
    const command = commandAt(root, path)
    if (command) annotate(command, { examples: [`${tool} personal conversations ${path} ${args}`.trimEnd()] })
  }
  commandAt(root, "links add")?.addHelpText(
    "after",
    "\nSet batch to the id from conversations batches show; supply the JSON answer to that batch on stdin.\n",
  )
}
