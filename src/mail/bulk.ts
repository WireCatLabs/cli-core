/** Mail sent to many: its own mailbox, so search can leave it out. Not a folder, so it proves nothing about deletions. */
export const BULK = "bulk"

export const bulkBox = { externalId: "memo:bulk", name: "bulk", kind: BULK }
