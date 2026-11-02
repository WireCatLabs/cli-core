import { readFileSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { privateFiles } from "../cli/messenger/private-files.js"
import type { OAuthClient } from "./provider.js"

const ClientFile = v.object({
  installed: v.object({ client_id: v.pipe(v.string(), v.minLength(1)), client_secret: v.optional(v.string()) }),
})

export interface ClientFileOptions {
  platform?: NodeJS.Platform
  /** Skip the owner-only check, for a file the package ships. Default: the file must be private to its owner. */
  shipped?: boolean
  /** Thrown when the file cannot be read or has the wrong shape. */
  invalid?: CliError
}

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
    const { installed } = v.parse(ClientFile, JSON.parse(readFileSync(location, "utf8")))
    return {
      clientId: installed.client_id,
      ...(installed.client_secret ? { clientSecret: installed.client_secret } : {}),
    }
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
