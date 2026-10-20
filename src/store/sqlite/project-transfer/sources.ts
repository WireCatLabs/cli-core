import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../../driver.js"
import { referenceOfThing, storedThing, type Thing } from "../things.js"
import type { SnapshotBudget } from "./budget.js"

const invalid = (): never => {
  throw new CliError("configuration_error", "project snapshot has an unavailable or unsupported dependency")
}
const scalar = new Set([
  "person",
  "bot",
  "organization",
  "project",
  "fact",
  "memory",
  "task",
  "note",
  "document",
  "message",
  "email",
  "chat",
  "identity",
  "account",
  "meeting",
  "meeting_transcript",
  "meeting_transcript_row",
])
const noText = new Set(["person", "bot", "organization", "project", "chat", "identity", "account"])

const texts: Record<string, { table: string; fields: string[]; where: string; join?: string }> = {
  document: {
    table: "documents",
    fields: ["n.title", "n.body"],
    where:
      "n.deleted_at IS NULL AND n.body IS NOT NULL AND CASE WHEN json_valid(n.metadata) THEN coalesce(json_extract(n.metadata,'$.catalog.active'),1) ELSE 1 END=1",
  },
  note: { table: "notes", fields: ["n.title", "n.body"], where: "n.deleted_at IS NULL" },
  message: {
    table: "messages",
    fields: ["n.text", "n.sent_at", "n.sender_name", "n.sender_chat_external_id", "i.provider", "i.external_id"],
    join: "LEFT JOIN identities i ON i.id=n.sender_identity_id",
    where: "n.deleted_at IS NULL",
  },
  email: {
    table: "emails",
    fields: ["n.subject", "coalesce(n.body_text,'')", "n.sent_at", "n.from_address", "n.from_name"],
    where: "n.deleted_at IS NULL",
  },
  meeting: {
    table: "meetings",
    fields: ["n.title", "n.description", "n.location", "n.started_at", "n.ended_at", "n.duration_ms", "n.timezone"],
    where: "n.deleted_at IS NULL",
  },
  meeting_transcript_row: {
    table: "meeting_transcript_rows",
    fields: ["n.position", "n.start_ms", "n.end_ms", "n.speaker_name", "n.text"],
    join: "JOIN meeting_transcripts t ON t.id=n.meeting_transcript_id JOIN meetings m ON m.id=t.meeting_id",
    where: "t.deleted_at IS NULL AND m.deleted_at IS NULL",
  },
}

export class ProjectSnapshotSources {
  readonly references = new Map<string, Thing>()
  private readonly byThing = new Map<string, string>()

  constructor(
    private readonly database: CacheDatabase,
    private readonly budget: SnapshotBudget,
  ) {}

  ref(type: unknown, id: unknown): string | null {
    if (type === null && id === null) return null
    if (typeof type !== "string" || !scalar.has(type) || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      return invalid()
    const key = `${type}:${id}`,
      cached = this.byThing.get(key)
    if (cached) return cached
    if (type === "project" || type === "organization") {
      const table = type === "project" ? "projects" : "organizations"
      if (!this.database.prepare(`SELECT 1 FROM ${table} WHERE id=? AND deleted_at IS NULL`).get(id)) return invalid()
    }
    const identifier = {
      message: [
        "FROM messages n JOIN chats c ON c.id=n.chat_id JOIN accounts a ON a.id=n.account_id WHERE n.id=?",
        ["n.external_id", "c.external_id", "a.external_id", "a.provider"],
      ],
      email: [
        "FROM emails n JOIN email_threads c ON c.id=n.email_thread_id JOIN accounts a ON a.id=n.account_id WHERE n.id=?",
        ["n.external_id", "c.external_id", "a.external_id", "a.provider"],
      ],
      chat: [
        "FROM chats n JOIN accounts a ON a.id=n.account_id WHERE n.id=?",
        ["n.external_id", "a.external_id", "a.provider"],
      ],
      identity: ["FROM identities n WHERE n.id=?", ["n.external_id", "n.provider"]],
    } as const
    const selection = identifier[type as keyof typeof identifier]
    if (selection) this.budget.rows(this.database, selection[0], [...selection[1]], [id])
    const thing = storedThing(type, id),
      ref = referenceOfThing(this.database, thing)
    if (!ref) return invalid()
    this.byThing.set(key, ref)
    this.references.set(ref, thing)
    return ref
  }

  external(owned: Set<string>) {
    return [...this.references]
      .filter(([ref]) => !owned.has(ref))
      .map(([ref, thing]) => ({
        ref,
        content_sha256: this.fingerprint(thing),
      }))
  }

  private fingerprint(thing: Thing): string | null {
    this.budget.reserve(1, 128)
    if (noText.has(thing.type)) return null
    if (thing.type === "meeting_transcript") return this.transcript(thing.id)
    const spec = texts[thing.type]
    if (!spec) return invalid()
    const from = `FROM ${spec.table} n ${spec.join ?? ""} WHERE n.id=? AND ${spec.where}`
    this.budget.rows(this.database, from, spec.fields, [thing.id])
    const row = this.database
      .prepare(`SELECT ${spec.fields.map((f, i) => `${f} AS v${i}`).join(",")} ${from}`)
      .get(thing.id)
    if (!row) return invalid()
    return this.digest(
      thing.type,
      spec.fields.map((_f, i) => row[`v${i}`]),
    )
  }

  private transcript(id: number) {
    const from =
      "FROM meeting_transcripts n JOIN meetings m ON m.id=n.meeting_id WHERE n.id=? AND n.deleted_at IS NULL AND m.deleted_at IS NULL"
    this.budget.rows(this.database, from, ["n.format", "n.language", "n.source"], [id])
    const header = this.database.prepare(`SELECT n.format,n.language,n.source ${from}`).get(id)
    if (!header) return invalid()
    const rows = "FROM meeting_transcript_rows n WHERE n.meeting_transcript_id=?"
    this.budget.rows(this.database, rows, ["n.position", "n.start_ms", "n.end_ms", "n.speaker_name", "n.text"], [id])
    const cues = this.database
      .prepare(`SELECT n.position,n.start_ms,n.end_ms,n.speaker_name,n.text ${rows} ORDER BY n.position LIMIT 1001`)
      .all(id)
    return this.digest("meeting_transcript", [header, cues])
  }

  private digest(kind: string, content: unknown) {
    return createHash("sha256")
      .update(JSON.stringify(["wirecat.project-source", 1, kind, content]))
      .digest("hex")
  }
}
