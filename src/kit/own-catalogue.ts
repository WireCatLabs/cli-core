import { describeProgram, hasSharedContract, metaOf } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { type CatalogueOptions, toolsFromCommands } from "../mcp/agent.js"

const sharedPaths = (command: Command, parents: readonly string[] = [], into = new Set<string>()) => {
  for (const child of command.commands) {
    const path = [...parents, child.name()]
    if (hasSharedContract(child) && metaOf(child).origin !== "generated") into.add(path.join(" "))
    sharedPaths(child, path, into)
  }
  return into
}

/**
 * The MCP catalogue of a CLI's own commands, by path, as `read` or `write`: what cli-core mounted is left out, since
 * cli-core pins it. A generated command (a Bot API method) is the CLI's own, as `commands --json` marks it. A CLI's contract test pins this and the few shared commands it changes on purpose.
 */
export const ownCatalogue = (program: Command, options: CatalogueOptions = {}): Record<string, "read" | "write"> => {
  const shared = sharedPaths(program)
  return Object.fromEntries(
    toolsFromCommands(describeProgram(program), options)
      .filter((tool) => !shared.has([...(options.root ?? []), tool.command].join(" ")))
      .map((tool) => [tool.command, tool.writes ? "write" : "read"]),
  )
}
