export { bareCheck, type CheckWords, checkWords } from "./domain/checks.js"
export type { CounterField, CounterObservation, CounterObservations, CounterState } from "./domain/counters.js"
export { COUNTER_FIELDS, counterValue, observedCounters } from "./domain/counters.js"
export {
  type FormattedText,
  type HtmlFormatting,
  type MarkdownFormatting,
  type TextSpan,
  validateFormattedText,
} from "./domain/formatting.js"
export { formatLocator, isLocator, type MessageLocator, parseLocator } from "./domain/locator.js"
export { type Markup, parseMarkdown } from "./domain/markdown.js"
export { parseMarkdownSpans } from "./domain/markdown-spans.js"
export type { MessageLink, MessagePermalink } from "./domain/message-link.js"
export type * from "./domain/models.js"
export { countedPoll } from "./domain/polls.js"
export {
  FOLDER_PROVIDERS,
  isFolderProvider,
  isKind,
  KINDS,
  type Kind,
  kindIn,
  kindOf,
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
  canonicalReference,
  formatReference,
  looksLikeReference,
  parseReference,
  REF_KINDS,
  type Reference,
  type RefKindName,
  type RefKindSpec,
} from "./domain/references.js"
export { normalizeTag, TAG_TYPES, type TagType } from "./domain/tags.js"
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
export { isId, type PeopleLookup, pickChat, pickPerson } from "./resolve.js"
export {
  atTerminal,
  type LoginQr,
  type LoginQrOptions,
  loginQr,
  PASTE_QR,
} from "./terminal/login-qr.js"
export { readSecret, type SecretInput } from "./terminal/prompt.js"
export { plainQr, terminalQr } from "./terminal/qr.js"
