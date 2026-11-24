import type { MailSource } from "./source.js"

export const GMAIL_ALL_MAIL = "[Gmail]/All Mail"

const listedFolders = (source?: Pick<MailSource, "folders">) =>
  source?.folders?.().then(
    (found) => found,
    () => undefined,
  )

/** The IMAP folder of mail the owner sent, as the source names it; Gmail's sent mail is in All Mail. */
export const sentFolder = async (
  account: { mode?: string },
  source?: Pick<MailSource, "folders">,
): Promise<string | undefined> => (account.mode === "imap" ? (await listedFolders(source))?.sent : undefined)

/**
 * The folders to read. Gmail names All Mail in the account's language, so it is found by its role; a source that
 * cannot say, or a listing without it, falls back to the English name and the read reports a missing folder. IMAP
 * reads INBOX and the Sent folder, since a contact's tie is mail the owner wrote.
 */
export const mailFolders = async (
  account: { mode?: string; folders?: string[] },
  source?: Pick<MailSource, "folders">,
): Promise<string[]> => {
  if (account.folders) return account.folders
  if (account.mode === "imap") {
    const sent = await sentFolder(account, source)
    return sent === undefined || sent === "INBOX" ? ["INBOX"] : ["INBOX", sent]
  }
  return [(await listedFolders(source))?.all ?? GMAIL_ALL_MAIL]
}
