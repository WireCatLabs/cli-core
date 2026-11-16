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

/** The keys Bitrix24 and amoCRM put a file's tokened link under. */
const LINK_KEYS = new Set(["urlMachine", "downloadUrlMachine", "pdfUrlMachine", "imageUrlMachine", "DOWNLOAD_URL"])
const TOKENED = /https?:\/\/\S*[?&](?:auth|token)=/iu
export const LINK_REMOVED = "[link removed]"

/**
 * A provider's answer with every link to a file replaced, for `api call`: such a link holds a token that lets anyone
 * download the file, so it must reach no output, store or log. Covers the keys the CRMs use, amoCRM's
 * `_links.download`, and any URL string that carries `auth=` or `token=`.
 */
export const withoutFileLinks = <T>(body: T): T => {
  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return TOKENED.test(value) ? LINK_REMOVED : value
    if (Array.isArray(value)) return value.map((one) => walk(one))
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).map(([name, one]) => [
        name,
        LINK_KEYS.has(name) || (key === "_links" && name === "download") ? LINK_REMOVED : walk(one, name),
      ]),
    )
  }
  return walk(body) as T
}
