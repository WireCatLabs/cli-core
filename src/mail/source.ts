import type { MailHeaders } from "./headers.js"
import type { FileStamp } from "./resume.js"

export interface Listed {
  uid: string
  /** Gmail's own ids: the same in every folder, and they survive a UID reset. */
  messageId: string
  threadId: string
  receivedAt: string
  folder?: string
  /** Gmail labels, plain names; absent when the answer could not be read, so nothing is changed. */
  labels?: string[]
  seen?: boolean
  flagged?: boolean
  /** RFC822.SIZE in bytes, to size fetch batches. */
  size?: number
  /** Read only when asked for; absent when not asked or unreadable, so no rule applies to it. */
  headers?: MailHeaders
}

export interface Searched {
  /** Absent when the server does not say; then no UID is trusted across runs. */
  validity?: string
  uids: string[]
}

/** Everything the import asks of a mail client, so a transport can be replaced without touching the sync. */
export interface MailSource {
  /**
   * How many messages one `list` call reads in about one request's time, parallel connections included; a budgeted
   * sync lists that many at a time, so a request of the budget is one call. Absent: 200.
   */
  listBatch?: number
  /** The same for `fetchRaw`. Absent: 50. */
  fetchBatch?: number
  /**
   * Every message in `folder` received since `since`; all or nothing, since deletions are proved from it.
   * `headers` also reads From, To, Cc and the list fields, for the probe and the owner's rules.
   */
  list(since: Date, folder: string, options?: { headers?: boolean; searched?: Searched }): Promise<Listed[]>
  /**
   * The folder's UIDs in the window and its UIDVALIDITY, without reading a message; `list` given them reads only
   * those. Absent for a file, which has no UIDs.
   */
  search?(since: Date, folder: string): Promise<Searched>
  /** A file's size and modification time, so an unchanged file read to the end is not read again. */
  stamp?(): Promise<FileStamp>
  /**
   * The messages of `folder` with these Gmail ids, listed as `list` lists them; a message no longer there is left
   * out. Absent where messages have no Gmail id: a file, or plain IMAP.
   */
  find?(messageIds: readonly string[], folder: string, options?: { headers?: boolean }): Promise<Listed[]>
  /**
   * Moves messages by Gmail id between folders on the server; ids `from` does not hold come back as missing.
   * `known` gives each id's UID in `from`, already read, so none is looked up again.
   */
  move?(
    messageIds: readonly string[],
    from: string,
    to: string,
    known?: ReadonlyMap<string, string>,
  ): Promise<{ moved: string[]; missing: string[] }>
  /** All Mail and Trash under the names this account's language gives them. */
  folders?(): Promise<{ all: string; trash: string }>
  /** Which of these UIDs `folder` still holds. */
  present?(uids: readonly string[], folder: string): Promise<string[]>
  /** Puts labels back on messages in `folder`, by Gmail id. */
  label?(messageIds: readonly string[], folder: string, labels: readonly string[]): Promise<void>
  /** Each item's raw RFC 5322 bytes, in order; one that could not be read is an Error, not a failed call. */
  fetchRaw(items: Listed[]): Promise<(Uint8Array | Error)[]>
}
