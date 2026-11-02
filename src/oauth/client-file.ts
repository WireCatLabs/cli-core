import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { privateFiles } from "../cli/messenger/private-files.js"
import type { OAuthClient } from "./provider.js"

export interface ClientFileOptions {
  platform?: NodeJS.Platform
  /** Skip the owner-only check, for a file the package ships. Default: the file must be private to its owner. */
  shipped?: boolean
  /** Thrown when the file cannot be read or has the wrong shape. */
  invalid?: CliError
}

// No schema library: the keeper-process test bundles this module without a node_modules next to it.
/**
 * Reads a Google Desktop OAuth client file (`{ "installed": { client_id, client_secret? } }`, the JSON Google's console
 * downloads). Refuses a file other users can read, and never puts the file's contents in an error.
 */
export const readClientFile = (location: URL | string, options: ClientFileOptions = {}): OAuthClient => {
  if (!options.shipped && typeof location === "string") {
    const mode = privateFiles({ files: [location], dirs: [] }, options.platform)
    if (mode.checked && !mode.ok)
      throw new CliError(
        "configuration_error",
        `the client file can be read by other users of this computer; run chmod 600 ${location} and try again`,
        { reason: "sign-in.client-file-open" },
      )
  }
  try {
    const { installed } = JSON.parse(readFileSync(location, "utf8")) as { installed: Record<string, unknown> }
    const { client_id: clientId, client_secret: clientSecret } = installed
    if (typeof clientId !== "string" || !clientId) throw new TypeError("client_id")
    if (clientSecret !== undefined && typeof clientSecret !== "string") throw new TypeError("client_secret")
    return { clientId, ...(clientSecret ? { clientSecret } : {}) }
  } catch {
    throw (
      options.invalid ??
      new CliError(
        "configuration_error",
        "could not read a Desktop app OAuth client JSON from the client file; its contents were not logged",
        { reason: "sign-in.client-file-invalid" },
      )
    )
  }
}
