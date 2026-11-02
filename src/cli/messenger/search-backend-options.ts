import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { parseDuration } from "../../domain/duration.js"
import type { Backend, ServerOptions, ServerSearched } from "../../services/server-search.js"
import type { Messenger, MessengerContext } from "./context.js"

const backendOf = (value: string): Backend => {
  if (value !== "archive" && value !== "server" && value !== "both")
    throw new CliError("validation_error", "--backend takes archive, server or both")
  return value
}

/** `--backend` and `--server-time`, for any search whose source has a server that searches: `where` names it. */
export const serverSearchOptions = (command: Command, where: string, defaultTime = "5s"): Command =>
  command
    .option("--backend <archive|server|both>", `where to search: the local archive, ${where}, or both`, backendOf)
    .option("--server-time <duration>", `stop waiting for the server after this long (default: ${defaultTime})`)

/** Mounted only where the messenger's server can search messages. */
export const backendOptions = (command: Command, messenger: Messenger): Command =>
  messenger.serverSearch
    ? serverSearchOptions(command, "the messenger's server (default: both; message discovery uses archive only)")
    : command

export const backendRequest = (command: Command): { backend?: Backend; server?: ServerOptions } => {
  const { backend, serverTime } = command.opts<{ backend?: Backend; serverTime?: string }>()
  return {
    ...(backend === undefined ? {} : { backend }),
    ...(serverTime === undefined ? {} : { server: { timeMs: parseDuration(serverTime, "--server-time") } }),
  }
}

export const noteServer = (context: Pick<MessengerContext, "renderer">, server: ServerSearched | undefined): void => {
  if (!server) return
  if (server.skipped) context.renderer.note(`server search skipped: ${server.skipped} — the answer is the archive's`)
  else if (!server.complete)
    context.renderer.note(
      `server search incomplete${server.failed.length ? `: ${[...new Set(server.failed.map(({ reason }) => reason))].join(", ")}` : ""}`,
    )
}
