export type TransferValues = Record<string, string | number | null>
export type TransferKind = "document" | "note" | "memory" | "fact"

export interface TransferEntity {
  key: string
  kind: TransferKind
  values: TransferValues
  revisions: TransferValues[]
}

export interface TransferExternal {
  key: string
  reference: string
  kind: string
  owner?: boolean
  bot?: { name: string; kind: string }
  collection?: string
  external_id?: string
  document_fingerprint?: string
  person?: { name: string | null; identities: TransferValues[] }
}

export interface TransferSnapshot {
  collection: TransferValues
  entities: TransferEntity[]
  taggings: TransferValues[]
  links: TransferValues[]
  aliases: TransferValues[]
  external: TransferExternal[]
}

export interface DocumentTransferOptions {
  source: string
  destination: string
  collection: string
  env?: NodeJS.ProcessEnv
  /** Explicit source-reference to destination-reference decisions, never display names. */
  bindings?: Record<string, string>
}

export interface DocumentTransferPreview {
  fingerprint: string
  source_documents: { external_id: string; content_hash: string | null }[]
  counts: {
    documents: number
    notes: number
    memories: number
    facts: number
    tags: number
    links: number
    people: number
    identities: number
    authors: number
    aliases: number
  }
  missing_bindings: string[]
  conflicts: string[]
  already_transferred: boolean
  ready: boolean
}

export interface DocumentTransferReceipt extends DocumentTransferPreview {
  references: Record<string, string>
  documents: Record<string, string>
}
