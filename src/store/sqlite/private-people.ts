import type { PrivateContact, PrivateContactNote } from "../contracts/private-people-types.js"

export type { PrivateContact, PrivateContactNote } from "../contracts/private-people-types.js"

import { CliError } from "@wirecat/cli-base"
import { fold } from "../normalize.js"
import type { AccountKey } from "../store.js"
import type { StoreContext } from "./open.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { toIso } from "./values.js"

const required = ({ database }: StoreContext, key: AccountKey, personId: string) => {
  const row = database
    .prepare(
      "SELECT a.id AS account_id, i.id AS identity_id FROM accounts a " +
        "JOIN account_identities ai ON ai.account_id=a.id JOIN identities i ON i.id=ai.identity_id " +
        "WHERE a.provider=? AND a.external_id=? AND i.provider=? AND i.external_id=?",
    )
    .get(key.provider, key.account, key.provider, personId)
  if (!row) throw new CliError("not_found", "this account has no stored identity with that id")
  return { account: Number(row.account_id), identity: Number(row.identity_id) }
}

const noteOf = (row: Record<string, unknown>, personId: string): PrivateContactNote => ({
  id: String(row.id),
  personId,
  text: String(row.body),
  revision: Number(row.revision),
  createdAt: toIso(Number(row.created_at)) as string,
  updatedAt: toIso(Number(row.updated_at)) as string,
})

const NOTES_ABOUT = "SELECT n.* FROM notes n WHERE notable_type='identity' AND notable_id=? AND deleted_at IS NULL"

export const privateContact = (context: StoreContext, key: AccountKey, personId: string): PrivateContact => {
  const { account, identity } = required(context, key, personId)
  const alias = context.database
    .prepare(
      "SELECT name AS alias FROM aliases WHERE account_id=? AND aliasable_type='identity' AND aliasable_id=? AND display=1",
    )
    .get(account, identity)?.alias
  const notes = context.database
    .prepare(`${NOTES_ABOUT} ORDER BY n.created_at, n.id`)
    .all(identity)
    .map((row) => noteOf(row, personId))
  return { personId, alias: alias == null ? null : String(alias), notes }
}

export const setAlias = (context: StoreContext, key: AccountKey, personId: string, alias: string | null) => {
  const { account, identity } = required(context, key, personId)
  const value = alias?.trim() ?? null
  if (value !== null && (value.length === 0 || value.length > 200))
    throw new CliError("validation_error", "an alias takes 1–200 characters")
  context.database
    .prepare("DELETE FROM aliases WHERE account_id=? AND aliasable_type='identity' AND aliasable_id=? AND display=1")
    .run(account, identity)
  if (value !== null)
    context.database
      .prepare(
        "INSERT INTO aliases (account_id, aliasable_type, aliasable_id, name, name_folded, display, source, created_at, updated_at) VALUES (?, 'identity', ?, ?, ?, 1, 'owner', ?, ?)",
      )
      .run(account, identity, value, fold(value), context.now(), context.now())
  resolvePersonLinks(context.database, [value])
  return { personId, alias: value }
}

const noteText = (text: string) => {
  const value = text.trim()
  if (!value || value.length > 100_000) throw new CliError("validation_error", "a note takes 1–100000 characters")
  return value
}

export const addNote = (context: StoreContext, key: AccountKey, personId: string, text: string) => {
  const { identity } = required(context, key, personId)
  const at = context.now()
  const row = context.database
    .prepare(
      "INSERT INTO notes (notable_type, notable_id, body, created_at, updated_at) VALUES ('identity', ?, ?, ?, ?) RETURNING *",
    )
    .get(identity, noteText(text), at, at)
  return noteOf(row as Record<string, unknown>, personId)
}

export const note = (context: StoreContext, key: AccountKey, personId: string, id: string): PrivateContactNote => {
  const found = privateContact(context, key, personId).notes.find((entry) => entry.id === id)
  if (!found) throw new CliError("not_found", "no private note with that id on this contact")
  return found
}

export const editNote = (
  context: StoreContext,
  key: AccountKey,
  personId: string,
  id: string,
  text: string,
  revision: number,
) => {
  const held = note(context, key, personId, id)
  const changed = context.database
    .prepare("UPDATE notes SET body=?, updated_at=?, revision=revision+1 WHERE id=? AND revision=?")
    .run(noteText(text), context.now(), id, revision).changes
  if (!changed) throw new CliError("validation_error", "the note changed; read its current revision before editing")
  context.database
    .prepare(
      "INSERT INTO note_revisions (note_id, body, revision, created_at) SELECT id, ?, revision-1, ? FROM notes WHERE id=?",
    )
    .run(held.text, context.now(), id)
  return note(context, key, personId, id)
}

export const removeNote = (context: StoreContext, key: AccountKey, personId: string, id: string) => {
  note(context, key, personId, id)
  context.database.prepare("DELETE FROM note_revisions WHERE note_id=?").run(id)
  context.database.prepare("DELETE FROM notes WHERE id=?").run(id)
  return { id, personId, removed: true }
}
