/**
 * Store area types and constants some CLIs use beyond the stable `@wirecat/cli-core/store`: experimental, so a
 * minor release may change them.
 */
export {
  type AddedSource,
  type AddedSourceContent,
  type AddedSourceInput,
  addedSourceKeyOf,
} from "./sqlite/added-sources.js"
export type { ContractFilter } from "./sqlite/business-contracts.js"
export type { CatalogEntry, CatalogInput, CatalogQuery } from "./sqlite/catalog.js"
export type { CrmChange, CrmChangeKind } from "./sqlite/crm-changes.js"
export { crmIdentityId } from "./sqlite/crm-rows.js"
export { crmSettingKey } from "./sqlite/crm-settings.js"
export type { Deal, DealFilter, Pipeline, PipelineReport } from "./sqlite/deals.js"
export type { EmailInput, FolderEmail, MailboxInput } from "./sqlite/emails.js"
export { type EvidenceInput, QUOTE_LIMIT, quoteKept } from "./sqlite/evidence-signature.js"
export type { Fact } from "./sqlite/facts.js"
export type { Invoice, Payment as FinancePayment } from "./sqlite/finance.js"
export type { IdentityRekey } from "./sqlite/identity-rekey.js"
export { IMPORTED_DOCUMENT_QUERY } from "./sqlite/imported-documents.js"
export {
  type KnowledgeRelation,
  type KnowledgeTarget,
  ORGANIZATION_KINDS,
  type Organization,
  PROJECT_TYPES,
  type Project,
  SCOPES,
} from "./sqlite/knowledge.js"
export type { MeetingVectors } from "./sqlite/meeting-vectors.js"
export type { Author, Memory } from "./sqlite/memories.js"
export type { TransactionFilter } from "./sqlite/money-transactions.js"
export type { Link, LinkInput, LinkListFilter, Note } from "./sqlite/notes.js"
export type { OrderFilter } from "./sqlite/orders.js"
export type { OrganizationErasure } from "./sqlite/organization-erase.js"
export { type ListedPerson, PEOPLE_SORTS, type PeopleSort } from "./sqlite/people-list.js"
export type { PersonDoubt } from "./sqlite/person-doubts.js"
export type { PersonErasure } from "./sqlite/person-erase.js"
export { type PersonMerge, parseMergeId } from "./sqlite/person-merges.js"
export type { ProductFilter } from "./sqlite/products.js"
export { PROPOSAL_STATUSES, type ProposedAction } from "./sqlite/proposed-actions.js"
export type { MatchRun, RecordKey } from "./sqlite/records.js"
export type { RelationListItem } from "./sqlite/relation-list.js"
export type { SubscriptionFilter } from "./sqlite/subscriptions.js"
export { PROJECT_TASK_FIELDS, TASK_SORTS, type TaskSort } from "./sqlite/task-board.js"
export { TASK_RELATION_KINDS, type TaskRelationKind } from "./sqlite/task-relations.js"
export type { TemplateAddress } from "./sqlite/templates.js"
export type { VocabularyKind, VocabularyOptions, VocabularyTarget } from "./sqlite/vocabulary.js"
export type { Wallet, WalletFilter } from "./sqlite/wallets.js"
export {
  TASK_ROLES,
  type TaskDetails,
  type TaskFields,
  type TaskRole,
  type TaskType,
  type WorkTaskType,
} from "./sqlite/work-tasks.js"
export { MENTION_QUERY, type StoredTag, type TagTarget } from "./store.js"
