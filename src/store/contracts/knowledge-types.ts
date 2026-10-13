import type { RELATION_KINDS } from "../sqlite/link-kinds.js"
import type { MeetingProjectsStore } from "../sqlite/meeting-projects.js"
import type { TagCreationOptions } from "../sqlite/tag-creation.js"
import type { Label, TagKind, TagRow } from "../sqlite/tags.js"
import type { ThingState } from "../sqlite/things.js"
import type { VocabularyStore } from "../sqlite/vocabulary.js"
import type { AccountKey } from "../store.js"

export type KnowledgeTarget =
  | { type: "message"; locator: string }
  | { type: "chat"; id: string }
  | { type: "contact"; id: string }
  | { type: "person"; id: string }
  | { type: "task"; id: string }
  | { type: "organization"; id: string }
  | { type: "project"; id: string }
  | { type: "note"; id: string }
  | { type: "document"; id: string }
  /** A meeting by its store id; one account's, like a chat. */
  | { type: "meeting"; id: string }
  /** A notes folder by id; `path` names one subfolder inside it, `null` or absent the whole folder. */
  | { type: "folder"; id: string; path?: string | null }

/**
 * Whose records a call reads: an account, or `null` for the owner's own — notes, people, organizations,
 * projects, tasks and folders belong to no account. A chat or contact target still needs its account.
 */
export type KnowledgeScope = AccountKey | null

export interface Annotation {
  id: string
  target: KnowledgeTarget
  targetState: ThingState
  text: string
  revision: number
  authoredBy: "owner"
  createdAt: string
  updatedAt: string
}

export interface Organization {
  id: string
  ref: string
  kind: (typeof ORGANIZATION_KINDS)[number]
  name: string
  scope: (typeof SCOPES)[number]
  createdAt: string
}

export interface Project {
  id: string
  ref: string
  key: string
  name: string
  type: (typeof PROJECT_TYPES)[number]
  organizationId: string | null
  scope: (typeof SCOPES)[number]
  createdAt: string
}

export interface KnowledgeRelation {
  id: string
  from: string
  to: string
  kind: (typeof RELATION_KINDS)[number]
  role: string | null
  evidence: string | null
  confirmed: boolean
  provenance: string | null
  confidenceCategory: "owner-confirmed" | "weak"
  createdAt: string
}

export interface Reminder {
  id: string
  task: string
  dueAt: string
  timezone: string
  state: "pending" | "leased" | "delivered" | "cancelled"
  revision: number
  receipt: string | null
}

export type LabelledType = "note" | "document" | "person" | "organization" | "project" | "task" | "meeting" | "folder"

export interface KnowledgeStore extends VocabularyStore, MeetingProjectsStore {
  taskIds(
    key: AccountKey,
    options?: { state?: "open" | "done" | "dismissed"; limit?: number; offset?: number; sources?: string[] },
  ): Promise<{ items: string[]; hasMore: boolean }>
  addAnnotation(key: KnowledgeScope, target: KnowledgeTarget, text: string): Promise<Annotation>
  annotations(
    key: KnowledgeScope,
    options?: { target?: KnowledgeTarget; search?: string; limit?: number; offset?: number },
  ): Promise<{ items: Annotation[]; hasMore: boolean }>
  annotation(key: KnowledgeScope, id: string): Promise<Annotation>
  editAnnotation(key: KnowledgeScope, id: string, text: string, revision: number): Promise<Annotation>
  removeAnnotation(key: KnowledgeScope, id: string): Promise<{ id: string; removed: true }>
  tags(key: KnowledgeScope, target: KnowledgeTarget): Promise<string[]>
  addTags(key: KnowledgeScope, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  removeTags(key: KnowledgeScope, target: KnowledgeTarget, tags: string[]): Promise<string[]>
  /**
   * A new tag or topic. Only the owner makes a topic (an agent proposes one: `actions.propose`), and a
   * name held by a tag cannot become a topic, nor the other way round.
   */
  createTag(name: string, options?: { kind?: TagKind; by?: "owner" | "agent" } & TagCreationOptions): Promise<TagRow>
  /** Marks a topic as the thing's main one, or clears it with `null`; one per thing. */
  setMainTopic(key: KnowledgeScope, target: KnowledgeTarget, topic: string | null): Promise<void>
  /** Every labelled note, document, person, organization, project, task and folder. */
  labelled(
    key: KnowledgeScope,
    options?: { tag?: string; type?: LabelledType; limit?: number; offset?: number },
  ): Promise<{
    items: { target: KnowledgeTarget; tags: string[]; labels: Label[]; targetState: ThingState }[]
    hasMore: boolean
  }>
  addOrganization(input: {
    kind: Organization["kind"]
    name: string
    scope?: Organization["scope"]
  }): Promise<Organization>
  organizations(): Promise<Organization[]>
  /** A project; its key is made from the name when none is given. */
  addProject(input: {
    name: string
    key?: string
    type?: Project["type"]
    organization?: string
    scope?: Project["scope"]
    description?: string
  }): Promise<Project>
  projects(): Promise<Project[]>
  relate(
    key: KnowledgeScope,
    input: {
      from: string
      to: string
      kind: KnowledgeRelation["kind"]
      role?: string
      evidence?: string
      confirmed?: boolean
      provenance?: string
    },
  ): Promise<KnowledgeRelation>
  relations(key: KnowledgeScope, reference?: string): Promise<KnowledgeRelation[]>
  removeRelation(key: KnowledgeScope, id: string): Promise<{ id: string; removed: true }>
  confirmRelation(key: KnowledgeScope, id: string): Promise<KnowledgeRelation>
  schedule(key: AccountKey, task: string, dueAt: string, timezone: string): Promise<Reminder>
  reminders(key: AccountKey): Promise<Reminder[]>
  cancelReminder(key: AccountKey, id: string): Promise<Reminder>
  snoozeReminder(key: AccountKey, id: string, dueAt: string, revision: number): Promise<Reminder>
  claimReminders(key: AccountKey, options?: { limit?: number; leaseMs?: number }): Promise<Reminder[]>
  acknowledgeReminder(key: AccountKey, id: string, receipt: string): Promise<Reminder>
}

export const ORGANIZATION_KINDS = ["company", "team", "family", "community"] as const

export const PROJECT_TYPES = ["work", "client", "personal", "oss", "other"] as const

export const SCOPES = ["personal", "work"] as const
