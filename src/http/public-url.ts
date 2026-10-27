import { CliError } from "@wirecat/cli-base"

const EXAMPLE = "--public-url https://<name>.ts.net"

/**
 * The tunnel's address a public listener is reached at, checked one way for every command that opens
 * one. `missing` says what needs it; `reaches` who calls through it, for the https refusal.
 */
export const publicUrlOf = (
  given: string | undefined,
  {
    missing,
    reaches,
    path = false,
  }: {
    missing: string
    reaches: string
    /** An MCP server may sit under a path of a shared address, `https://<name>.ts.net/tg`, one per tool. */
    path?: boolean
  },
): URL => {
  if (!given) throw new CliError("configuration_error", `${missing} needs the tunnel's address: ${EXAMPLE}`)
  let url: URL
  try {
    url = new URL(given)
  } catch {
    throw new CliError("validation_error", `--public-url is not an address: ${EXAMPLE}`)
  }
  if (url.username || url.password)
    throw new CliError("validation_error", "--public-url must not contain login credentials")
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !local)
    throw new CliError("validation_error", `--public-url must be https — ${reaches} through it`)
  if (url.search || url.hash || (!path && url.pathname !== "/"))
    throw new CliError(
      "validation_error",
      path
        ? `--public-url is the tunnel's address, or a path of it, without a query: ${EXAMPLE}/tg`
        : `--public-url is the tunnel's address only, without a path: ${EXAMPLE}`,
    )
  if (path && !/^(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/.test(url.pathname))
    throw new CliError("validation_error", "--public-url's path takes letters, digits, dot, dash and underscore: /tg")
  if (path) url.pathname = url.pathname.replace(/\/+$/, "") || "/"
  return url
}

/** A local port from `--port`, or the command's own default. */
export const portOf = (given: string | undefined, fallback: number): number => {
  if (given === undefined) return fallback
  const port = Number(given)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliError("validation_error", "--port takes 1–65535")
  return port
}

/** The connector address under a public address: `https://<name>.ts.net/mcp`, or `…/tg/mcp` under a path. */
export const mcpUrlOf = (publicUrl: URL): URL =>
  new URL(`${publicUrl.pathname.replace(/\/+$/, "")}/mcp`, publicUrl.origin)
