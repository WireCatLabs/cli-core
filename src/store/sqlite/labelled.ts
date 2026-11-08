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
