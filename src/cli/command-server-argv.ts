/**
 * `<cli> commands --serve`: one process that runs command after command for WireCat Desktop, which otherwise pays a
 * whole Node start for each read on a page. Matched before the program loads, so it is in no help, no `commands`
 * document and no MCP catalogue — and a flag, because `commands <path>` already describes every top-level word.
 */
export const COMMAND_SERVER_ARGV: readonly string[] = ["commands", "--serve"]

export const isCommandServer = (args: readonly string[]): boolean =>
  args.length === COMMAND_SERVER_ARGV.length && COMMAND_SERVER_ARGV.every((word, at) => args[at] === word)
