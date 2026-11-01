export { BULK, bulkBox } from "./bulk.js"
export { factsOf } from "./facts.js"
export { GMAIL_ALL_MAIL, mailFolders } from "./folders.js"
export { dropMissing, type Gone, tooManyGone } from "./gone.js"
export { type AuthVerdicts, HEADER_FIELDS, headersOf, type MailHeaders, mailHeadersOf } from "./headers.js"
export { decodeMailboxName, labelName, systemLabel } from "./labels.js"
export {
  type Address,
  htmlToText,
  looksLikeHtml,
  MAX_BODY_CHARS,
  type ParsedMail,
  parseMail,
} from "./parse.js"
export { PRESET_NAMES, PRESETS, type PresetName, presetMatches } from "./presets.js"
export { domainsToAge, groupKey, type Probe, type ProbeGroup, probeMail, SUGGEST_RULE } from "./probe.js"
export { type MailFolderProgress, mailProgress } from "./progress.js"
export {
  ATTACHMENT_CHARS,
  attachmentsText,
  hitText,
  lowerSuspicious,
  type MailSearch,
  type ShownMail,
  searchMail,
  showMail,
  withAttachmentText,
} from "./read.js"
export {
  type FileStamp,
  FULL_PASS_MS,
  MBOX_RESUME,
  type MboxPoint,
  mergeRanges,
  parsePoint,
  type Ranges,
  type ResumePoint,
  rangesOf,
  resumeKey,
  rulesKey,
  within,
} from "./resume.js"
export { ruleInput, STORE_ACTION } from "./rule-input.js"
export { storedMailRule, storedMailRules } from "./rule-stored.js"
export { mapProposedTags, ruleTagger, settleRuleTags, type TagOutcome } from "./rule-tags.js"
export {
  conditionKeys,
  decide,
  describeMatch,
  ENVELOPE,
  envelopeBox,
  envelopeBoxOf,
  type MailAction,
  type MailFacts,
  type MailRule,
  type MailRuleMatch,
  matches,
  sameMatch,
  tagsOf,
} from "./rules.js"
export {
  type DomainAge,
  FRAUD_SIGNALS,
  FREE_MAIL,
  registrableOf,
  SCORE_RULE,
  type Scored,
  type Signal,
  scoreGroup,
  WEIGHTS,
} from "./score.js"
export {
  DEMOTE_AT,
  type DomainAges,
  demotedSenders,
  type LookupResult,
  SCORE_VERSION,
  scoreSenders,
} from "./sender-scores.js"
export { type MailCriteria, mailCriteriaOf, narrows } from "./server-query.js"
export { type MailServerAccess, type MailServerRequest, searchMailServer } from "./server-search.js"
export type { Listed, MailSource, Quick, Searched } from "./source.js"
export { listedOf, type StoredMail } from "./stored.js"
export {
  MAX_ATTACHMENT_CHARS,
  type MailAccount,
  type MailIndexed,
  type MailSyncOptions,
  type MailSyncResult,
  RETRYABLE_ATTACHMENTS,
  syncMail,
} from "./sync.js"
