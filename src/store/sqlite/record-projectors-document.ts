import { type DocumentText, documentWritesOver } from "./added-sources.js"
import { linkKind } from "./link-kinds.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { given, type Projection, type ProjectionTools, type RecordProjector } from "./record-projection.js"

const TEXT_ONLY = { storage: "text", localPath: null } as const

const textOf = ({ fields, externalId }: Projection): DocumentText => {
  const text = String(fields.text ?? "")
  return {
    kind: "text",
    title: given<string>(fields, "title") ?? externalId.slice(0, 500),
    fileName: null,
    extension: null,
    url: given<string>(fields, "url") ?? null,
    mime: null,
    size: null,
    hash: null,
    text,
    extraction: text ? "text" : "none",
    metadata: null,
    language: null,
  }
}

const momentOf = (fields: Projection["fields"], name: string): number | null => {
  const at = Date.parse(given<string>(fields, name) ?? "")
  return Number.isNaN(at) ? null : at
}

/** The import's own `about` links, written again from the record each time; the owner's stay as they are. */
const relinkAbout = ({ database, now }: StoreContext, id: number, subjects: readonly string[]) => {
  database
    .prepare(
      `DELETE FROM links WHERE from_type = 'document' AND from_id = ? AND kind = ${linkKind("about")} AND source = 'import'`,
    )
    .run(id)
  const at = now()
  for (const subject of subjects) {
    const thing = requiredThing(database, subject, "a subject")
    database
      .prepare(
        `INSERT OR IGNORE INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author,
           updated_at) VALUES ('document', ?, ?, ?, ${linkKind("about")}, 'import', 1, ?, 'import', ?)`,
      )
      .run(id, thing.type, thing.id, at, at)
  }
}

/** A document of the envelope's own account under the record's external id: changed text is its next revision. */
const saveDocument = (projection: Projection, { context }: ProjectionTools): string => {
  const { database } = context
  const writes = documentWritesOver(context)
  const document = textOf(projection)
  const at = context.now()
  const own = database
    .prepare("SELECT * FROM documents WHERE account_id = ? AND external_id = ?")
    .get(projection.accountId, projection.externalId)
  let id: number
  if (own === undefined) id = writes.insert(projection.accountId, projection.externalId, document, TEXT_ONLY, at)
  else {
    id = Number(own.id)
    if (own.deleted_at != null) writes.revive(id, document, TEXT_ONLY, at)
    else writes.update(own, document, at, String(own.body ?? "") !== document.text)
  }
  database
    .prepare("UPDATE documents SET external_created_at = ?, external_updated_at = ? WHERE id = ?")
    .run(momentOf(projection.fields, "created_at"), momentOf(projection.fields, "updated_at"), id)
  writes.place(id, at, document.title ?? projection.externalId)
  relinkAbout(context, id, projection.related.get("about") ?? [])
  return `document:${id}`
}

export const DOCUMENT_PROJECTORS = {
  document: {
    create: saveDocument,
    update: (_ref, projection, tools) => {
      saveDocument(projection, tools)
      return true
    },
    remove: (ref, { context }) => {
      documentWritesOver(context).remove(requiredThing(context.database, ref).id, context.now())
    },
    restore: (_ref, projection, tools) => {
      saveDocument(projection, tools)
    },
  },
} as const satisfies Record<string, RecordProjector>
