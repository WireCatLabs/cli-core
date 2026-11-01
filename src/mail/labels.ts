const SYSTEM_LABELS: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  important: "Important",
  starred: "Starred",
  draft: "Drafts",
  drafts: "Drafts",
  spam: "Spam",
  trash: "Trash",
  junk: "Spam",
}

/** IMAP's modified UTF-7 (RFC 3501 §5.1.3): `&` opens base64 of UTF-16BE, `,` stands for `/`, `-` closes. */
export const decodeMailboxName = (name: string): string =>
  name.replace(/&([^-]*)-/g, (_, run: string) => {
    if (run === "") return "&"
    const bytes = Buffer.from(run.replace(/,/g, "/"), "base64")
    let text = ""
    for (let at = 0; at + 1 < bytes.length; at += 2) text += String.fromCharCode(bytes.readUInt16BE(at))
    return text
  })

export const systemLabel = (name: string): string => SYSTEM_LABELS[name.toLowerCase()] ?? name

/**
 * A label as people read it, from a name already decoded (imapflow decodes X-GM-LABELS): `\\Important` and
 * `Important` are one label. Decoding twice would turn `R&D-team` into `Rteam`.
 */
export const decodedLabelName = (name: string): string => {
  const system = name.startsWith("\\") ? name.slice(1) : name
  return SYSTEM_LABELS[system.toLowerCase()] ?? system
}

/** The same from X-GM-LABELS as the server sends it, in modified UTF-7. */
export const labelName = (raw: string): string => decodedLabelName(decodeMailboxName(raw))
