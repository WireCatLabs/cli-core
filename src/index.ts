export {
  CATALOG_KINDS,
  type CatalogKind,
  CONTRACT_KINDS,
  CONTRACT_STATUSES,
  type ContractKind,
  type ContractStatus,
  type Interval,
  intervalOf,
  intervalText,
  ORDER_DIRECTIONS,
  type OrderDirection,
  PERIOD_UNITS,
  type PeriodUnit,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
  TRANSACTION_STATUSES,
  type TransactionStatus,
  WALLET_KINDS,
  type WalletKind,
} from "./domain/business.js"
export { bareCheck, type CheckWords, checkWords } from "./domain/checks.js"
export type { CounterField, CounterObservation, CounterObservations, CounterState } from "./domain/counters.js"
export { COUNTER_FIELDS, counterValue, observedCounters } from "./domain/counters.js"
export {
  CRM_KINDS,
  type CrmDepartment,
  type CrmField,
  type CrmItem,
  type CrmKind,
  type CrmOrganization,
  type CrmPerson,
  type CrmPipeline,
  type CrmRecords,
  type CrmStage,
  type CrmUser,
  type CrmValue,
  isItemKind,
} from "./domain/crm.js"
export {
  DEAL_KINDS,
  DEAL_ROLES,
  DEAL_STATUSES,
  type DealKind,
  type DealRole,
  type DealStatus,
  STAGE_OUTCOMES,
  type StageOutcome,
} from "./domain/deals.js"
export {
  FINANCE_REVIEWS,
  type FinanceReview,
  INVOICE_DIRECTIONS,
  INVOICE_STATUSES,
  type InvoiceDirection,
  type InvoiceStatus,
  MONEY_DIRECTIONS,
  type MoneyDirection,
} from "./domain/finance.js"
export {
  type FormattedText,
  type HtmlFormatting,
  type MarkdownFormatting,
  type TextSpan,
  validateFormattedText,
} from "./domain/formatting.js"
export {
  DEFAULT_LINK_CONFIG,
  type DeepLinkTarget,
  formatLink,
  LINK_VERSION,
  type LinkConfig,
  type LinkForm,
  linkConfigOf,
  linkFor,
  linkTargetOf,
  parseLink,
} from "./domain/links.js"
export { formatLocator, isLocator, type MessageLocator, parseLocator } from "./domain/locator.js"
export { type Markup, parseMarkdown } from "./domain/markdown.js"
export { parseMarkdownSpans } from "./domain/markdown-spans.js"
export type { MessageLink, MessagePermalink } from "./domain/message-link.js"
export type * from "./domain/models.js"
export {
  CURRENCY_SCALES,
  currencyOf,
  formatDecimal,
  type Money,
  minorUnits,
  moneyLabel,
  moneyOf,
  signedMinorUnits,
} from "./domain/money.js"
export {
  ORDER_PURPOSES,
  ORDER_STATUSES,
  type OrderPurpose,
  type OrderStatus,
} from "./domain/orders.js"
export { countedPoll } from "./domain/polls.js"
export {
  ADDED_ACCOUNT,
  ADDED_PROVIDER,
  CRM_OPENS,
  FOLDER_PROVIDERS,
  holdsKind,
  isFolderProvider,
  isKind,
  KINDS,
  type Kind,
  kindIn,
  kindOf,
  kindsIn,
  PROVIDERS,
  type ProviderEntry,
  providerNamed,
  providers,
  UNKNOWN_PROVIDER,
  useProviders,
} from "./domain/providers.js"
export type { RankingGraphEvidence, RankingGraphLink } from "./domain/rankings-graph.js"
export type {
  RankingComponent,
  RankingInput,
  RankingMeasure,
  RankingOptions,
  RankingTarget,
  RankingWeights,
  ScorePreset,
} from "./domain/rankings-options.js"
export { rankingOptions } from "./domain/rankings-options.js"
export {
  type EnvelopeOptions,
  type EnvelopeRecord,
  type EnvelopeSource,
  envelopeOfJsonl,
  envelopeOfText,
  type IngestError,
  RECORD_ENTITY_TYPES,
  RECORD_OPERATIONS,
  RECORDS_ENVELOPE_SCHEMA,
  RECORDS_SCHEMA_VERSION,
  type RecordEntityType,
  type RecordOperation,
  type RecordRelation,
  type RecordsEnvelope,
} from "./domain/records.js"
export {
  canonicalReference,
  formatReference,
  looksLikeReference,
  parseReference,
  REF_KINDS,
  type Reference,
  type RefKindName,
  type RefKindSpec,
} from "./domain/references.js"
export {
  byEngagement,
  ENGAGEMENT_LEVELS,
  type Engagement,
  engagementRank,
  inverseOf,
  isUsable,
  ORGANIZATION_ROLES,
  PROJECT_ROLES,
  RELATION_KINDS,
  RELATIONS,
  type RelationKind,
  ROLE_LISTS,
  type RoleList,
  rolesOf,
  STANDINGS,
  type Standing,
  standingOf,
  usableLink,
} from "./domain/relations.js"
export { normalizeTag, TAG_TYPES, type TagType } from "./domain/tags.js"
export { envelopeOfVcard, isVcard, type VcardIssue, type VcardOptions } from "./domain/vcard.js"
export { type AppErrors, DETAILS as CORE_DETAILS, failureContext, REASONS as CORE_REASONS } from "./errors/reasons.js"
export {
  canonicalMeetingReference,
  formatMeetingReference,
  type MeetingReference,
  parseMeetingReference,
} from "./meetings/index.js"
export type { CheckRow, Finding, Moderator } from "./moderation/check.js"
export { act, judge } from "./moderation/check.js"
export type { GroupRules } from "./moderation/rules.js"
export { defaultRules, ModerationRules, moderationPathFor } from "./moderation/rules.js"
export { type OutputOptions, resolveOutput } from "./output.js"
export { pollLines, type RenderOptions, renderMessage, renderMessages } from "./render/messages.js"
export { foldName, isId, type PeopleLookup, pickChat, pickPerson } from "./resolve.js"
export {
  atTerminal,
  type LoginQr,
  type LoginQrOptions,
  loginQr,
  PASTE_QR,
} from "./terminal/login-qr.js"
export { readSecret, type SecretInput } from "./terminal/prompt.js"
export { plainQr, terminalQr } from "./terminal/qr.js"
