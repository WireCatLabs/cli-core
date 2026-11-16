import { CliError } from "@wirecat/cli-base"
import { CRM_KINDS, type CrmKind } from "../domain/crm.js"
import { CRM_FILE_SOURCES, type CrmFileOwner, type CrmFileSourceKind } from "./source.js"

/** A file's id as `files list` prints it: the owner and the source first, so a download knows whom to ask. */
export const crmFileId = (owner: CrmFileOwner, source: CrmFileSourceKind, providerId: string): string =>
  `${owner.kind}:${owner.id}:${source}:${providerId}`

/** The parts of a file id; a malformed one is refused before anything is asked. */
export const parseCrmFileId = (id: string): { owner: CrmFileOwner; source: CrmFileSourceKind; providerId: string } => {
  const [kind = "", owner = "", source = "", ...rest] = id.trim().split(":")
  const providerId = rest.join(":")
  if (
    !(CRM_KINDS as readonly string[]).includes(kind) ||
    !/^[\w.-]+$/u.test(owner) ||
    !(CRM_FILE_SOURCES as readonly string[]).includes(source) ||
    !providerId
  )
    throw new CliError(
      "validation_error",
      "a file id is <owner kind>:<owner id>:<source>:<id>, as files list prints it, such as deal:12:record:345",
      { reason: "ref.malformed" },
    )
  return { owner: { kind: kind as CrmKind, id: owner }, source: source as CrmFileSourceKind, providerId }
}

const foldKey = (key: string) => key.replaceAll("_", "").toLowerCase()

/**
 * The keys a file's download link sits under, folded: Bitrix24's "Types of Links in Responses" (apidocs
 * files/how-to-download-files), a generated document's `publicUrl` (opens it with no sign-in), a call's record, and
 * every `…Machine` key. A view link alone (`url`, `urlShow`) is not one: a link field holds `{ url, title }` the same way.
 */
const DOWNLOAD_KEYS = new Set(
  ["DOWNLOAD_URL", "downloadUrl", "fileUrl", "CALL_RECORD_URL", "archiveLink", "publicUrl"].map(foldKey),
)
const isDownloadKey = (key: string) => DOWNLOAD_KEYS.has(foldKey(key)) || foldKey(key).endsWith("machine")

// A webhook's `/rest/<user>/<code>/` is the webhook itself.
const WEBHOOK = /\/rest\/\d+\/[^/\s"'?#]+\//iu
// A portal's tokened paths, relative ones too; a site the owner typed, `?token=promo` and all, is none.
const PORTAL_PATH = /\/rest\/|show_file\.php/iu
// `&amp;` too: a link copied out of HTML, as a comment or a mail body holds one.
const TOKEN_QUERY = /(?:[?&]|&amp;)(?:auth|token|access_token)=[^&#\s]/iu
// Credentials whatever the path: a Bitrix24 `auth`, an OAuth or API token, a signed storage link.
const CREDENTIAL = /(?:[?&]|&amp;)(?:auth|access_token|api_token|x-amz-signature)=[^&#\s]/iu

const isTokened = (value: string) =>
  WEBHOOK.test(value) || CREDENTIAL.test(value) || (PORTAL_PATH.test(value) && TOKEN_QUERY.test(value))

export const LINK_REMOVED = "[link removed]"

/**
 * A provider's answer with every file link replaced by `[link removed]`, the rest as given: such a link lets anyone
 * download the file, so it must reach no output, store or log. Covers the download keys, amoCRM's `_links.download`,
 * and any string holding a webhook, a credential, or a portal path with a token.
 */
export const withoutFileLinks = <T>(body: T): T => {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return isTokened(value) ? LINK_REMOVED : value
    if (Array.isArray(value)) return value.map((one) => walk(one))
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).map(([name, one]) => [
        name,
        (isDownloadKey(name) || (key === "_links" && name === "download")) && one !== null && one !== ""
          ? LINK_REMOVED
          : walk(one, name),
      ]),
    )
  }
  return walk(body) as T
}
