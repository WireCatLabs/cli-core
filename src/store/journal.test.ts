import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { storeRecoveryCheck } from "../cli/store-recover.js"
import { journalMarkPath, readJournalMark } from "./marks.js"
import { openStoreContext } from "./sqlite/open-store.js"
import { write } from "./sqlite/transaction.js"

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "store-journal-")), "m.db")
  const context = await openStoreContext({ path, command: "chat", warn: () => {} })
  return { path, database: context.database }
}

let account = 0
const addAccount = (database: Awaited<ReturnType<typeof opened>>["database"]) =>
  write(database, () => {
    account += 1
    database
      .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('chat', ?, 0, 0)")
      .run(String(account))
  })

describe("the store's journal file", () => {
  it("refuses the next commit once another program deletes it, and the report names that as the cause", async () => {
    const { path, database } = await opened()
    addAccount(database)
    unlinkSync(`${path}-wal`)

    expect(() => addAccount(database)).toThrow(
      expect.objectContaining({ details: { reason: "store.journal-replaced" } }),
    )
    expect(readJournalMark(path)).toMatchObject({ command: "chat", seen: "missing" })
    database.close()

    const check = await storeRecoveryCheck({ MESSAGING_STORE: path }, "chat")
    expect(check.ok).toBe(true)
    expect(check.report?.whatHappened).toMatch(/journal file \(m\.db-wal\) was deleted or replaced/)
    expect(check.report?.likelyCauses[0]?.cause).toMatch(/another program/)
    expect(check.next.at(-1)).toBe("chat store recover")
    expect(existsSync(journalMarkPath(path))).toBe(false)
  })

  it("sees a journal replaced by a new file", async () => {
    const { path, database } = await opened()
    addAccount(database)
    unlinkSync(`${path}-wal`)
    writeFileSync(`${path}-wal`, "")

    expect(() => addAccount(database)).toThrow(/deleted or replaced by another program/)
    expect(readJournalMark(path)?.seen).toBe("replaced")
    database.close()
  })

  it("notes a shared-memory file without its journal at open, and writes on", async () => {
    const { path, database } = await opened()
    database.close()
    writeFileSync(`${path}-shm`, "")

    const reopened = await openStoreContext({ path, command: "chat", warn: () => {} })
    addAccount(reopened.database)
    reopened.database.close()
    expect(readJournalMark(path)?.seen).toBe("shm-without-wal")
  })

  it("leaves a store whose journal stays alone", async () => {
    const { path, database } = await opened()
    addAccount(database)
    addAccount(database)
    database.close()
    expect(readJournalMark(path)).toBeNull()
  })
})
