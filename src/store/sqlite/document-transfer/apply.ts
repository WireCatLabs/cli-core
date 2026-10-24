import { CliError } from "@wirecat/cli-base"
import { folderProviderOf } from "../../../domain/providers.js"
import type {
  DocumentTransferReceipt,
  TransferEntity,
  TransferSnapshot,
  TransferValues,
} from "../../document-transfer/model.js"
import type { CacheDatabase, SqlValue } from "../../driver.js"
import { botNamed, ownerPerson } from "../actors.js"
import { syncFile } from "../files.js"
import { canonicalTagNamed } from "../tags.js"
import { referenceOfThing, type Thing } from "../things.js"
import { write } from "../transaction.js"
import { copyPeople } from "./people.js"
import { planTransfer } from "./plan.js"
import { TRANSFER_TABLES } from "./snapshot.js"

/** A file exported before store version 32 names its folder `folder`; here it gets the provider its format says. */
const providerHere = ({ provider, name, settings }: TransferValues): string | number | null => {
  if (provider !== "folder" || String(name ?? "").startsWith("google-drive:")) return provider ?? null
  return folderProviderOf(formatOf(settings) === "markdown" ? "markdown" : "obsidian")
}

const formatOf = (settings: unknown): unknown => {
  try {
    return (JSON.parse(String(settings)) as { format?: unknown } | null)?.format
  } catch {
    return undefined
  }
}

const COLUMNS = {
  document:
    "account_id external_id kind title location file_name extension url storage local_path mime size content_hash front_matter body normalized_text extraction extraction_error language revision export_path external_created_at external_updated_at metadata created_at updated_at deleted_at",
  note: "notable_type notable_id title body author_type author_id revision created_at updated_at deleted_at",
  memory:
    "kind body subject_type subject_id author_type author_id model confidence status last_verified_at supersedes_id scope created_at updated_at deleted_at",
  fact: "type statement status project_id subject_type subject_id occurred_at supersedes_id author_type author_id model confirmed_by_type confirmed_by_id scope source metadata created_at updated_at deleted_at",
} as const
const LINK_COLUMNS =
  "from_type from_id to_type to_id kind anchor source target_text target_folded role evidence metadata confirmed created_at author updated_at"
const TAGGING_COLUMNS = "tag_id taggable_type taggable_id main source author_type author_id created_at updated_at"

const insert = (database: CacheDatabase, table: string, columns: string, values: TransferValues) => {
  const fields = columns.split(" ")
  const row = database
    .prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) RETURNING id`)
    .get(...fields.map((field) => values[field] ?? null))
  return Number(row?.id)
}

const mapped = (mappings: Map<string, Thing>, type: unknown, id: unknown): Thing | undefined => {
  if (type == null && id == null) return undefined
  const result = mappings.get(`${String(type)}:${String(id)}`)
  if (!result)
    throw new CliError("configuration_error", "an annotation reference was not resolved; the transfer was rolled back")
  return result
}

export const applyTransfer = (
  database: CacheDatabase,
  snapshot: TransferSnapshot,
  sourceKey: string,
  bindings: Record<string, string>,
  expectedFingerprint: string,
  now: () => number,
): DocumentTransferReceipt =>
  write(database, () => {
    const plan = planTransfer(database, snapshot, sourceKey, bindings)
    if (plan.preview.fingerprint !== expectedFingerprint)
      throw new CliError("validation_error", "the transfer preview changed; preview it again before applying")
    if (!plan.preview.ready)
      throw new CliError(
        "configuration_error",
        "the transfer has unresolved references or conflicts; preview it before applying",
      )
    const mappings = plan.mappings
    const references = () =>
      Object.fromEntries(
        [...mappings].map(([key, value]) => [key, referenceOfThing(database, value) ?? `${value.type}:${value.id}`]),
      )
    const documents = (refs: Record<string, string>) =>
      Object.fromEntries(
        snapshot.entities
          .filter((entity) => entity.kind === "document")
          .map((entity) => [String(entity.values.external_id), refs[entity.key] as string]),
      )
    if (plan.preview.already_transferred) {
      const refs = references()
      return { ...plan.preview, references: refs, documents: documents(refs) }
    }
    copyPeople(database, snapshot, mappings, now)
    const owner = ownerPerson(database)
    for (const external of snapshot.external)
      if (external.bot && !mappings.has(external.key))
        mappings.set(external.key, botNamed(database, external.bot.name, now(), external.bot.kind as "agent"))
    let collectionId = plan.collectionId
    if (collectionId === undefined) {
      const organization =
        snapshot.collection.organization_id == null
          ? undefined
          : mapped(mappings, "organization", snapshot.collection.organization_id)
      collectionId = insert(
        database,
        "accounts",
        "provider external_id name created_at settings updated_at scope organization_id",
        {
          ...snapshot.collection,
          provider: providerHere(snapshot.collection),
          organization_id: organization?.id ?? null,
        },
      )
    }
    mappings.set(`account:${String(snapshot.collection.id)}`, { type: "account", id: collectionId })
    const inserted = new Set<string>()
    const ordered = [...snapshot.entities].sort((a, b) => Number(a.kind !== "document") - Number(b.kind !== "document"))
    for (const entity of ordered) {
      if (mappings.has(entity.key)) continue
      const values = { ...entity.values }
      if (entity.kind === "document") values.account_id = collectionId
      else {
        for (const prefix of ["notable", "subject", "author", "confirmed_by"]) {
          if (!Object.hasOwn(values, `${prefix}_type`)) continue
          const required = prefix === "notable" || (prefix === "author" && entity.kind !== "note")
          values[`${prefix}_type`] = required ? owner.type : null
          values[`${prefix}_id`] = required ? owner.id : null
        }
        if (Object.hasOwn(values, "supersedes_id")) values.supersedes_id = null
        if (Object.hasOwn(values, "project_id")) values.project_id = null
      }
      const id = insert(database, TRANSFER_TABLES[entity.kind], COLUMNS[entity.kind], values)
      if (entity.kind === "document") syncFile(database, now(), id, { seen: false })
      mappings.set(entity.key, { type: entity.kind, id })
      inserted.add(entity.key)
    }
    for (const entity of ordered) {
      const destination = mappings.get(entity.key) as Thing
      if (inserted.has(entity.key)) remapEntity(database, entity, destination.id, mappings)
      if (entity.kind === "document" || entity.kind === "note") {
        const table = entity.kind === "document" ? "document_revisions" : "note_revisions"
        for (const revision of entity.revisions) {
          const existing = database
            .prepare(`SELECT body FROM ${table} WHERE ${entity.kind}_id=? AND revision=?`)
            .get(destination.id, Number(revision.revision))
          if (existing) continue
          insert(database, table, `${entity.kind}_id body revision created_at`, {
            ...revision,
            [`${entity.kind}_id`]: destination.id,
          })
        }
      }
    }
    for (const tagging of snapshot.taggings) {
      const tag = canonicalTagNamed(database, String(tagging.tag_name))
      const tagId = tag
        ? Number(tag.id)
        : insert(database, "canonical_tags", "name kind created_at updated_at", {
            name: tagging.tag_name ?? null,
            kind: tagging.tag_kind ?? null,
            created_at: tagging.created_at ?? null,
            updated_at: tagging.updated_at ?? null,
          })
      const subject = mapped(mappings, tagging.taggable_type, tagging.taggable_id) as Thing
      const author = mapped(mappings, tagging.author_type, tagging.author_id)
      if (
        database
          .prepare("SELECT id FROM taggings WHERE tag_id=? AND taggable_type=? AND taggable_id=?")
          .get(tagId, subject.type, subject.id)
      )
        continue
      insert(database, "taggings", TAGGING_COLUMNS, {
        ...tagging,
        tag_id: tagId,
        taggable_type: subject.type,
        taggable_id: subject.id,
        author_type: author?.type ?? null,
        author_id: author?.id ?? null,
      })
    }
    for (const alias of snapshot.aliases) {
      const sourceTag = snapshot.taggings.find((tagging) => tagging.tag_id === alias.aliasable_id)
      const targetTag = canonicalTagNamed(database, String(sourceTag?.tag_name))
      if (!targetTag)
        throw new CliError(
          "configuration_error",
          "an imported label alias has no canonical tag; the transfer was rolled back",
        )
      const existing = database
        .prepare(
          "SELECT id FROM aliases WHERE aliasable_type='tag' AND aliasable_id=? AND account_id IS NULL AND name_folded=?",
        )
        .get(targetTag.id, String(alias.name_folded))
      if (!existing)
        insert(
          database,
          "aliases",
          "aliasable_type aliasable_id account_id name name_folded display source created_at updated_at",
          { ...alias, aliasable_id: targetTag.id },
        )
    }
    for (const link of snapshot.links) {
      const from = mapped(mappings, link.from_type, link.from_id) as Thing
      const to = mapped(mappings, link.to_type, link.to_id)
      insert(database, "links", LINK_COLUMNS, {
        ...link,
        from_type: from.type,
        from_id: from.id,
        to_type: to?.type ?? null,
        to_id: to?.id ?? null,
      })
    }
    database
      .prepare(
        "INSERT INTO document_annotation_transfers (source_key,collection,snapshot_hash,bindings_hash,reference_map,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        sourceKey,
        String(snapshot.collection.external_id),
        plan.snapshotHash,
        plan.bindingsHash,
        JSON.stringify(Object.fromEntries(mappings)),
        now(),
      )
    const refs = references()
    return { ...plan.preview, references: refs, documents: documents(refs) }
  })

const remapEntity = (database: CacheDatabase, entity: TransferEntity, id: number, mappings: Map<string, Thing>) => {
  const columns: string[] = [],
    values: SqlValue[] = []
  for (const prefix of ["notable", "subject", "author", "confirmed_by"]) {
    if (!Object.hasOwn(entity.values, `${prefix}_type`)) continue
    const target = mapped(mappings, entity.values[`${prefix}_type`], entity.values[`${prefix}_id`])
    columns.push(`${prefix}_type=?`, `${prefix}_id=?`)
    values.push(target?.type ?? null, target?.id ?? null)
  }
  if (Object.hasOwn(entity.values, "supersedes_id")) {
    columns.push("supersedes_id=?")
    values.push(
      entity.values.supersedes_id == null
        ? null
        : (mapped(mappings, entity.kind, entity.values.supersedes_id) as Thing).id,
    )
  }
  if (Object.hasOwn(entity.values, "project_id")) {
    columns.push("project_id=?")
    values.push(
      entity.values.project_id == null ? null : (mapped(mappings, "project", entity.values.project_id) as Thing).id,
    )
  }
  if (columns.length)
    database.prepare(`UPDATE ${TRANSFER_TABLES[entity.kind]} SET ${columns.join(",")} WHERE id=?`).run(...values, id)
}
