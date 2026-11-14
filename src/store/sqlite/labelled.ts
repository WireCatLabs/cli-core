export type LabelledType = "note" | "document" | "person" | "organization" | "project" | "task" | "meeting" | "folder"

/** What a label without an account may sit on; a chat, contact or message is the messenger's tag. */
export const LABELLED: Record<string, LabelledType> = {
  note: "note",
  document: "document",
  person: "person",
  organization: "organization",
  project: "project",
  task: "task",
  meeting: "meeting",
  account: "folder",
}

/**
 * A meeting is one account's, like a chat: with the account id bound twice, a tagging of another account's meeting is
 * left out, and with `NULL` none is; a deleted meeting's never counts.
 */
export const accountMeetingTagging = (alias: string): string =>
  `(${alias}.taggable_type <> 'meeting' OR EXISTS (SELECT 1 FROM meetings mt WHERE mt.id = ${alias}.taggable_id ` +
  "AND mt.deleted_at IS NULL AND (? IS NULL OR mt.account_id = ?)))"
