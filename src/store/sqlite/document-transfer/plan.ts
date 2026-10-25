import { CliError } from "@wirecat/cli-base"
import { digest } from "../../document-transfer/digest.js"
import type { DocumentTransferPreview, TransferSnapshot } from "../../document-transfer/model.js"
import type { CacheDatabase } from "../../driver.js"
import { ownerPerson } from "../actors.js"
import { tagMemberIds } from "../tag-resolution.js"
import { canonicalTagNamed } from "../tags.js"
import { stateOfThing, type Thing, thingOf } from "../things.js"
import { collectionAccounts, collectionNameOf, movedFromOf } from "./collection.js"
import { planPeople } from "./people.js"

export interface TransferPlan {
  preview: DocumentTransferPreview
  mappings: Map<string, Thing>
  collectionId?: number
  snapshotHash: string
  bindingsHash: string
}

export const planTransfer = (
  database: CacheDatabase,
  snapshot: TransferSnapshot,
  sourceKey: string,
  bindings: Record<string, string>,
): TransferPlan => {
  const mappings = new Map<string, Thing>()
  const missing = new Set<string>(),
    conflicts = new Set<string>()
  const snapshotHash = digest(snapshot)
  const bindingsHash = digest(Object.entries(bindings).sort(([a], [b]) => a.localeCompare(b)))
  const collection = String(snapshot.collection.external_id)
  const targets = collectionAccounts(database, collectionNameOf(snapshot.collection))
  if (targets.length > 1) conflicts.add("the destination has duplicate document collection identities")
  const target = targets[0]
  if (!target && database.prepare("SELECT id FROM accounts WHERE provider='folder' AND external_id=?").get(collection))
    conflicts.add("source collection identity is held by another destination collection")
  const hasReceipts = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_annotation_transfers'")
    .get()
  const receipt =
    hasReceipts &&
    database
      .prepare("SELECT * FROM document_annotation_transfers WHERE source_key=? AND collection IN (?,?,?) LIMIT 1")
      .get(
        sourceKey,
        collection,
        String(movedFromOf(snapshot.collection)?.external_id ?? collection),
        String(movedFromOf(target)?.external_id ?? collection),
      )
  if (receipt && (receipt.snapshot_hash !== snapshotHash || receipt.bindings_hash !== bindingsHash))
    conflicts.add(
      "the source or binding decisions changed after a completed transfer; keep the original store selected",
    )
  if (target && target.scope !== snapshot.collection.scope)
    conflicts.add("the destination collection has a different scope or an organization binding")
  for (const entity of snapshot.entities) {
    if (entity.kind !== "document" || !target) continue
    const existing = database
      .prepare("SELECT * FROM documents WHERE account_id=? AND external_id=?")
      .get(Number(target.id), String(entity.values.external_id))
    if (!existing) continue
    mappings.set(entity.key, { type: "document", id: Number(existing.id) })
    for (const field of ["body", "content_hash", "deleted_at", "revision"])
      if (existing[field] !== entity.values[field]) conflicts.add(`destination content differs for ${entity.key}`)
    for (const revision of entity.revisions) {
      const row = database
        .prepare("SELECT body FROM document_revisions WHERE document_id=? AND revision=?")
        .get(Number(existing.id), Number(revision.revision))
      if (row && row.body !== revision.body) conflicts.add(`destination revision differs for ${entity.key}`)
    }
  }
  if (receipt && receipt.snapshot_hash === snapshotHash && receipt.bindings_hash === bindingsHash)
    for (const [key, value] of Object.entries(JSON.parse(String(receipt.reference_map)) as Record<string, Thing>))
      mappings.set(key, value)
  const personPlan = planPeople(database, snapshot, mappings, bindings, conflicts)
  const knownBindings = new Set(snapshot.external.map((item) => item.reference))
  for (const key of Object.keys(bindings))
    if (!knownBindings.has(key))
      throw new CliError("validation_error", "a transfer binding names a reference outside the source annotation graph")
  for (const external of snapshot.external) {
    let found: Thing | undefined = mappings.get(external.key)
    if (personPlan.creatable.has(external.key) && bindings[external.reference] === undefined) continue
    if (external.key === `account:${String(snapshot.collection.id)}` && bindings[external.reference] === undefined) {
      if (target) mappings.set(external.key, { type: "account", id: Number(target.id) })
      continue
    }
    const binding = bindings[external.reference]
    if (binding !== undefined) found = thingOf(database, binding)
    else if (external.owner) found = ownerPerson(database)
    else if (external.bot) {
      const bot = database.prepare("SELECT id,kind FROM bots WHERE name=?").get(external.bot.name)
      if (bot && bot.kind !== external.bot.kind) conflicts.add(`destination bot kind differs for ${external.reference}`)
      if (bot) found = { type: "bot", id: Number(bot.id) }
      // A new author handle is created without copying credentials, settings or metadata.
      else continue
    } else if (external.collection && external.external_id) {
      const holders = JSON.stringify(collectionAccounts(database, external.collection).map(({ id }) => Number(id)))
      const row = database
        .prepare(
          "SELECT id FROM documents WHERE account_id IN (SELECT value FROM json_each(?)) AND external_id=? AND deleted_at IS NULL ORDER BY id LIMIT 1",
        )
        .get(holders, external.external_id)
      if (row) found = { type: "document", id: Number(row.id) }
    } else if (["message", "chat", "identity", "email", "email_thread"].includes(external.kind))
      found = thingOf(database, external.reference)
    if (found?.type === "document" && external.document_fingerprint) {
      const content = database.prepare("SELECT body,content_hash,deleted_at FROM documents WHERE id=?").get(found.id)
      if (!content || digest(content) !== external.document_fingerprint)
        conflicts.add(`destination evidence content differs for ${external.reference}`)
    }
    if (found && found.type === external.kind && stateOfThing(database, found) === "available")
      mappings.set(external.key, found)
    else missing.add(external.reference)
  }
  const organization =
    snapshot.collection.organization_id == null
      ? null
      : mappings.get(`organization:${String(snapshot.collection.organization_id)}`)?.id
  if (target && target.organization_id !== organization)
    conflicts.add("the destination collection has a different organization binding")
  for (const tagging of snapshot.taggings) {
    if (Number(tagging.tag_group_size ?? 1) > 1)
      conflicts.add(
        `source tag ${String(tagging.tag_id)} belongs to a consolidated group; annotation transfer cannot preserve that group yet`,
      )
    const tag = canonicalTagNamed(database, String(tagging.tag_name))
    if (tag && tagMemberIds(database, tag.id).length > 1)
      conflicts.add(
        `destination tag ${String(tag.id)} belongs to a consolidated group; annotation transfer cannot preserve independent contributions yet`,
      )
    if (tag && tag.name !== tagging.tag_name)
      conflicts.add(`destination vocabulary resolves source tag ${String(tagging.tag_id)} to another canonical label`)
    if (tag && tag.kind !== tagging.tag_kind)
      conflicts.add(`destination tag kind differs for source tag ${String(tagging.tag_id)}`)
    const subject = mappings.get(`${String(tagging.taggable_type)}:${String(tagging.taggable_id)}`)
    if (!subject) continue
    const existing =
      tag &&
      database
        .prepare("SELECT source,main FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
        .get(Number(tag.id), subject.type, subject.id)
    if (existing && (existing.source !== tagging.source || existing.main !== tagging.main))
      conflicts.add(`destination tag assignment differs for ${subject.type}:${subject.id}`)
    if (tagging.main === 1) {
      const main = database
        .prepare("SELECT tag_id FROM taggings WHERE taggable_type=? AND taggable_id=? AND main=1")
        .get(subject.type, subject.id)
      if (main && Number(main.tag_id) !== Number(tag?.id))
        conflicts.add(`destination primary topic differs for ${subject.type}:${subject.id}`)
    }
  }
  for (const alias of snapshot.aliases) {
    const sourceTag = snapshot.taggings.find((tagging) => tagging.tag_id === alias.aliasable_id)
    const named = canonicalTagNamed(database, String(alias.name))
    const targetTag = sourceTag && canonicalTagNamed(database, String(sourceTag.tag_name))
    if (named && named.id !== targetTag?.id)
      conflicts.add(`destination alias conflicts with source tag ${String(alias.aliasable_id)}`)
    if (targetTag && alias.display === 1) {
      const displayed = database
        .prepare(
          "SELECT name_folded FROM aliases WHERE aliasable_type='tag' AND aliasable_id=? AND account_id IS NULL AND display=1",
        )
        .get(targetTag.id)
      if (displayed && displayed.name_folded !== alias.name_folded)
        conflicts.add(`destination display alias conflicts with source tag ${String(alias.aliasable_id)}`)
    }
  }
  const counts = {
    documents: snapshot.entities.filter((item) => item.kind === "document").length,
    notes: snapshot.entities.filter((item) => item.kind === "note").length,
    memories: snapshot.entities.filter((item) => item.kind === "memory").length,
    facts: snapshot.entities.filter((item) => item.kind === "fact").length,
    tags: snapshot.taggings.length,
    links: snapshot.links.length,
    people: personPlan.people,
    identities: personPlan.identities,
    authors: snapshot.external.filter((item) => item.bot && !mappings.has(item.key)).length,
    aliases: snapshot.aliases.length,
  }
  if (receipt && conflicts.size === 0) {
    for (const [key, value] of Object.entries(JSON.parse(String(receipt.reference_map)) as Record<string, Thing>)) {
      if (stateOfThing(database, value) === "unavailable") conflicts.add("a transferred destination record is missing")
      mappings.set(key, value)
    }
  }
  const fingerprint = digest({
    sourceKey,
    snapshotHash,
    bindingsHash,
    collection: target?.id ?? null,
    mappings: [...mappings.entries()].sort(([a], [b]) => a.localeCompare(b)),
    conflicts: [...conflicts],
    missing: [...missing],
  })
  return {
    preview: {
      fingerprint,
      source_documents: snapshot.entities
        .filter((entity) => entity.kind === "document")
        .map((entity) => ({
          external_id: String(entity.values.external_id),
          content_hash: entity.values.content_hash == null ? null : String(entity.values.content_hash),
        }))
        .sort((a, b) => a.external_id.localeCompare(b.external_id)),
      counts,
      missing_bindings: [...missing].sort(),
      conflicts: [...conflicts].sort(),
      already_transferred: Boolean(receipt) && conflicts.size === 0 && missing.size === 0,
      ready: conflicts.size === 0 && missing.size === 0,
    },
    mappings,
    snapshotHash,
    bindingsHash,
    ...(target ? { collectionId: Number(target.id) } : {}),
  }
}
