import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import type { ResolvedNode } from "../search/lucene/resolved.js"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**documents, notes and mail are read for mentions from version 16**, and rebuild reads what came before", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-16-")), "wirecat.db")
  await (await openStore({ path })).close()
  const database = await openCache(path)
  rollBackTo(database, 16)
  database.close()

  const raw = new DatabaseSync(path)
  raw.exec(`INSERT INTO accounts (id, provider, external_id, created_at, updated_at) VALUES (1, 'email', 'a@example.com', 1, 1);
    INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, 1, 't1', 1, 1);
    INSERT INTO emails (account_id, email_thread_id, external_id, body_text, created_at, updated_at)
      VALUES (1, 1, 'e-old', 'call +7 900 000-00-01', 1, 1);`)
  raw.close()

  const upgraded = await openStore({ path })
  const after = new DatabaseSync(path)
  after.exec(`INSERT INTO documents (account_id, external_id, kind, body, created_at, updated_at)
      VALUES (1, 'd1', 'file', 'see https://example.org/a', 1, 1);
    INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at) VALUES ('person', 1, 'ana@example.com', 1, 1);`)
  expect(after.prepare("SELECT source_type FROM mention_pending ORDER BY source_type").all()).toEqual([
    { source_type: "document" },
    { source_type: "note" },
  ])
  after.close()

  expect(await upgraded.mentions.rebuildMentions()).toMatchObject({ documents: 1, notes: 1, emails: 1, mentions: 3 })
  const check = new DatabaseSync(path)
  expect(check.prepare("SELECT source_type, kind, value FROM mentions ORDER BY source_type").all()).toEqual([
    { source_type: "document", kind: "url", value: "https://example.org/a" },
    { source_type: "email", kind: "phone", value: "+79000000001" },
    { source_type: "note", kind: "email", value: "ana@example.com" },
  ])
  check.exec("UPDATE notes SET deleted_at = 2")
  expect(check.prepare("SELECT count(*) AS n FROM mention_pending WHERE source_type = 'note'").get()).toEqual({ n: 1 })
  check.close()
  const phone = {
    kind: "predicate",
    field: "phone",
    operator: "term",
    value: "8 900 000-00-01",
    span: { start: 0, end: 21 },
  } as unknown as ResolvedNode
  const mail = await upgraded.queries.matchQuery({
    root: phone,
    accounts: [{ provider: "email", account: "a@example.com" }],
    limit: 10,
    corpus: "mail",
  })
  expect(mail.items.map(({ id }) => id)).toEqual(["e-old"])
  await upgraded.close()
})
