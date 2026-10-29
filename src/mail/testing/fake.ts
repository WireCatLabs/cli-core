import { CliError } from "@wirecat/cli-base"
import { GMAIL_ALL_MAIL } from "../folders.js"
import { headersOf } from "../headers.js"
import type { FileStamp } from "../resume.js"
import type { Listed, MailSource, Searched } from "../source.js"

export type FakePerson = [name: string | null, address: string]

/** One message of a fake Gmail-like mailbox: its ids, envelope and the parts `rawOf` writes as RFC 5322. */
export interface FakeMail {
  uid: string
  messageId: string
  threadId: string
  receivedAt: string
  subject: string
  from: FakePerson
  to: FakePerson[]
  cc?: FakePerson[]
  text?: string
  html?: string
  listId?: string
  attachment?: { name: string; mime: string; content: string }
  extraHeaders?: string[]
  /** Plain label names, as a listing gives them; `flagged` adds Starred. */
  labels?: string[]
  seen?: boolean
  flagged?: boolean
  /** `trash` puts it in the trash folder; otherwise it is in All Mail, which INBOX also shows. */
  folder?: "trash"
}

/** The mailbox a fake source reads live, so a test changes it between syncs; the switches make the source fail. */
export interface FakeMailbox {
  messages: FakeMail[]
  /** All Mail under the account's language, as Gmail names it. */
  allMail?: string
  trash?: string
  validity?: number
  /** Each answer of `search` and `list` ends in this failure. */
  searchFails?: string
  /** A refused header fetch fails the whole listing. */
  headersFail?: boolean
  moveFails?: boolean
  /** UIDs whose raw bytes cannot be read: `fetchRaw` answers an Error for each of them, and only for them. */
  unreadable?: string[]
  /** UIDs that fail once, as a server's backend error does: `list` leaves each out, `fetchRaw` answers an Error. */
  failOnce?: string[]
  /** Calls the source answered, by kind, so a test counts a budget's requests. */
  calls?: { search: number; list: number; fetchRaw: number }
  /** What the source tells a budgeted sync about its batch sizes. */
  listBatch?: number
  fetchBatch?: number
  /** What the source was asked: the UIDs of each listing, and `msgid:<id>` for each `find`. */
  asked?: string[]
}

const TRASH = "[Gmail]/Bin"

const person = ([name, address]: FakePerson) => (name ? `"${name}" <${address}>` : address)

/** The RFC 5322 bytes of a fake message, CRLF line ends, the body and attachment in base64. */
export const rawOf = (m: FakeMail): Uint8Array => {
  const type = m.html ? "text/html" : "text/plain"
  const headers = [
    `From: ${person(m.from)}`,
    `To: ${m.to.map(person).join(", ")}`,
    ...(m.cc ? [`Cc: ${m.cc.map(person).join(", ")}`] : []),
    ...(m.listId ? [`List-Id: News <${m.listId}>`, `List-Unsubscribe: <mailto:leave@${m.listId}>`] : []),
    `Subject: ${m.subject}`,
    `Message-ID: <${m.messageId}@example.test>`,
    `Date: ${new Date(m.receivedAt).toUTCString()}`,
    "MIME-Version: 1.0",
    ...(m.extraHeaders ?? []),
  ]
  const body = Buffer.from(m.html ?? m.text ?? "").toString("base64")
  if (!m.attachment)
    return Buffer.from(
      `${[...headers, `Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64"].join("\r\n")}\r\n\r\n${body}\r\n`,
    )
  const parts = [
    `--b1\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`,
    `--b1\r\nContent-Type: ${m.attachment.mime}\r\nContent-Disposition: attachment; filename="${m.attachment.name}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${Buffer.from(m.attachment.content).toString("base64")}`,
  ]
  return Buffer.from(
    `${[...headers, 'Content-Type: multipart/mixed; boundary="b1"'].join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--b1--\r\n`,
  )
}

const failure = (message: string) => new CliError("provider_error", message, { reason: "mail.source-failed" })

const labelsOf = (m: FakeMail): string[] =>
  [...new Set([...(m.labels ?? []), ...(m.flagged ? ["Starred"] : [])])].sort()

const listingOf = (m: FakeMail, headers: boolean, folder: string): Listed => ({
  uid: m.uid,
  messageId: m.messageId,
  threadId: m.threadId,
  receivedAt: new Date(m.receivedAt).toISOString(),
  size: rawOf(m).length,
  labels: labelsOf(m),
  seen: m.seen ?? false,
  flagged: m.flagged ?? false,
  ...(headers ? { headers: headersOf(Buffer.from(rawOf(m)).toString().split("\r\n\r\n")[0] ?? "") } : {}),
  folder,
})

/**
 * An in-memory mail source with Gmail's shape: ids and threads that outlive a folder, labels and flags, UIDVALIDITY,
 * a trash a move reaches, and All Mail under the account's language. The sync tests and the adapter contract run on it.
 */
export const fakeMailSource = (mailbox: FakeMailbox): MailSource => {
  const all = () => mailbox.allMail ?? GMAIL_ALL_MAIL
  const trash = () => mailbox.trash ?? TRASH
  const inFolder = (folder: string): FakeMail[] => {
    if (![all(), trash(), "INBOX"].includes(folder)) throw failure(`Gmail has no such mailbox: ${folder}`)
    return mailbox.messages.filter((m) => (folder === trash() ? m.folder === "trash" : m.folder !== "trash"))
  }
  const search = async (since: Date, folder: string): Promise<Searched> => {
    if (mailbox.searchFails) throw failure(mailbox.searchFails)
    const from = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
    return {
      validity: String(mailbox.validity ?? 12),
      uids: inFolder(folder)
        .filter((m) => Date.parse(m.receivedAt) >= from)
        .map((m) => m.uid),
    }
  }

  const failedOnce = new Set<string>()
  const failsNow = (uid: string) => {
    if (!mailbox.failOnce?.includes(uid) || failedOnce.has(uid)) return false
    failedOnce.add(uid)
    return true
  }
  const count = (kind: "search" | "list" | "fetchRaw") => {
    if (mailbox.calls) mailbox.calls[kind] += 1
  }

  return {
    ...(mailbox.listBatch === undefined ? {} : { listBatch: mailbox.listBatch }),
    ...(mailbox.fetchBatch === undefined ? {} : { fetchBatch: mailbox.fetchBatch }),
    search: async (since, folder) => {
      count("search")
      return search(since, folder)
    },

    list: async (since, folder, options) => {
      count("list")
      const { uids } = options?.searched ?? (await search(since, folder))
      if (uids.length > 0) mailbox.asked?.push(uids.join(","))
      if (options?.headers && mailbox.headersFail) throw failure("the header fetch was refused")
      const wanted = new Set(uids)
      return inFolder(folder)
        .filter((m) => wanted.has(m.uid) && !failsNow(m.uid))
        .map((m) => listingOf(m, options?.headers ?? false, folder))
    },

    find: async (messageIds, folder, options) => {
      for (const id of messageIds) mailbox.asked?.push(`msgid:${id}`)
      const found = inFolder(folder).filter((m) => messageIds.includes(m.messageId))
      if (found.length > 0) mailbox.asked?.push(found.map((m) => m.uid).join(","))
      return found.map((m) => listingOf(m, options?.headers ?? false, folder))
    },

    move: async (messageIds, from, to) => {
      if (mailbox.moveFails) throw failure("UID MOVE did not complete")
      const here = inFolder(from).filter((m) => messageIds.includes(m.messageId))
      if (here.length === 0) return { moved: [], missing: [...messageIds] }
      for (const m of here) {
        if (to === trash()) {
          m.folder = "trash"
          m.labels = (m.labels ?? []).filter((label) => label !== "Inbox")
        } else {
          delete m.folder
          if (to === "INBOX" && !(m.labels ?? []).includes("Inbox")) m.labels = ["Inbox", ...(m.labels ?? [])]
        }
      }
      const moved = here.map((m) => m.messageId)
      return { moved, missing: messageIds.filter((id) => !moved.includes(id)) }
    },

    folders: async () => ({ all: all(), trash: trash() }),

    present: async (uids, folder) => inFolder(folder).flatMap((m) => (uids.includes(m.uid) ? [m.uid] : [])),

    label: async (messageIds, folder, labels) => {
      for (const m of inFolder(folder))
        if (messageIds.includes(m.messageId)) m.labels = [...new Set([...(m.labels ?? []), ...labels])]
    },

    fetchRaw: async (items) => {
      count("fetchRaw")
      return items.map((item) => {
        const m = mailbox.messages.find((each) => each.uid === item.uid)
        if (m === undefined || mailbox.unreadable?.includes(item.uid) || failsNow(item.uid))
          return failure(`email ${item.uid} was not read`)
        return rawOf(m)
      })
    },
  }
}

/**
 * A snapshot source, as an mbox file is: every message since a date with no UIDs, one stamp that changes when the
 * file does, and no search, find or folders. `archive.mails` and `archive.stamp` are read live.
 */
export const fakeArchiveSource = (archive: { mails: FakeMail[]; stamp: FileStamp }): MailSource => ({
  list: async (since, folder) =>
    archive.mails
      .filter((m) => Date.parse(m.receivedAt) >= since.getTime())
      .map((m) => ({ ...listingOf(m, true, folder), uid: "" })),
  stamp: async () => ({ ...archive.stamp }),
  fetchRaw: async (items) =>
    items.map((item) => {
      const m = archive.mails.find((each) => each.messageId === item.messageId)
      return m === undefined ? failure(`email ${item.messageId} was not found`) : rawOf(m)
    }),
})
