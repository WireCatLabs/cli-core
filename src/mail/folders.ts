import type { MailSource } from "./source.js"

export const GMAIL_ALL_MAIL = "[Gmail]/All Mail"

/**
 * The folders to read. Gmail names All Mail in the account's language, so it is found by its role; a source that
 * cannot say, or a listing without it, falls back to the English name and the read reports a missing folder.
 */
export const mailFolders = async (
  account: { mode?: string; folders?: string[] },
  source?: Pick<MailSource, "folders">,
): Promise<string[]> => {
  if (account.folders) return account.folders
  if (account.mode === "imap") return ["INBOX"]
  const all = await source?.folders?.().then(
    ({ all }) => all,
    () => undefined,
  )
  return [all ?? GMAIL_ALL_MAIL]
}
