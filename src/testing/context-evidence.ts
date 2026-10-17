import type { ContextEvidenceRequest, ContextSource } from "../context/evidence.js"
import { createContextEvidenceReader } from "../services/context-evidence.js"
import { normalize } from "../store/normalize.js"
import { contextEvidenceOver } from "../store/sqlite/context-evidence.js"
import { drainNoteIndex } from "../store/sqlite/note-index.js"
import { stemmerCache } from "../store/sqlite/stems.js"
import { preparationFixture } from "./meeting-preparation.js"

export const contextEvidenceFixture = async (provider = "example-calendar") => {
  const f = await preparationFixture(provider)
  const db = f.db
  for (const id of [f.accountId, f.otherId]) {
    db.prepare(
      "INSERT INTO chats(id,account_id,external_id,kind,title,created_at,updated_at) VALUES(?,?,'planning','group','Research Example',0,0)",
    ).run(id, id)
    for (const [n, at] of [
      [1, 100],
      [2, 200],
      [3, 300],
    ] as const) {
      const text = `Harbour launch ${n}`
      db.prepare(
        "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,1,0,0,'history')",
      ).run(id, id, String(n), at, text, normalize(text))
    }
  }
  const folder = await f.store.notes.addFolder({ name: "Example research" })
  const { note: doc } = await f.store.notes.saveFileNote({
    folderId: folder.id,
    path: "launch.md",
    title: "Harbour",
    text: "Launch checklist",
  })
  drainNoteIndex(db, stemmerCache())
  const mailId = await f.store.accounts.saveAccount(
    { provider: "email", account: "example-mail" },
    { name: "Example mail" },
  )
  db.prepare("INSERT INTO email_threads(id,account_id,external_id,created_at,updated_at) VALUES(1,?,'thread',0,0)").run(
    mailId,
  )
  db.prepare(
    "INSERT INTO emails(id,account_id,email_thread_id,external_id,subject,body_text,sent_at,created_at,updated_at) VALUES(1,?,1,'letter','Harbour','Launch agreement',200,0,0)",
  ).run(mailId)
  db.prepare("INSERT INTO email_words(rowid,normalized_text,scope) VALUES(1,'harbour launch agreement','')").run()
  db.exec("DELETE FROM email_index_pending")
  const source = (kind: ContextSource["kind"], accountId: number): ContextSource => {
    const row = db.prepare("SELECT provider,external_id FROM accounts WHERE id=?").get(accountId)
    if (!row) throw new Error("Missing fixture account")
    return { kind, accountId, provider: String(row.provider), account: String(row.external_id) }
  }
  const sources = {
    message: source("message", f.accountId),
    document: source("document", Number(folder.id)),
    mail: source("mail", mailId),
  }
  if (!f.store.contextEvidence) throw new Error("Missing context reader")
  const port = contextEvidenceOver({ database: db })
  const reader = createContextEvidenceReader(port, Object.values(sources))
  const request: ContextEvidenceRequest = {
    source: sources.message,
    query: "harbour",
    after: 100,
    before: 301,
    limit: 1,
  }
  return { ...f, folder, doc, mailId, port, reader, request, sources }
}
