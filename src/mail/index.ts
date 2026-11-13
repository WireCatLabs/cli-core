export { mailOwnText } from "../conversations/mail-text.js"
export { mailAccountKey } from "./account-key.js"
export { DEFAULT_ATTACHMENT_POLICY, type MailAttachmentPolicy, POLICY_SKIPS } from "./attachments.js"
export { BULK, bulkBox } from "./bulk.js"
export { factsOf } from "./facts.js"
export {
  MAIL_FINDING_FIELDS,
  MAIL_FINDINGS_KIND,
  MAIL_FINDINGS_PER_RUN,
  MAIL_FINDINGS_PER_SENDER,
  type MailFinding,
  type MailFindingsInput,
  mailFindingFieldsHelp,
  mailFindingFingerprint,
  validateMailFindings,
} from "./findings.js"
export { GMAIL_ALL_MAIL, mailFolders } from "./folders.js"
export { dropMissing, type Gone, tooManyGone } from "./gone.js"
export { type AuthVerdicts, HEADER_FIELDS, headersOf, type MailHeaders, mailHeadersOf } from "./headers.js"
export { type MailIdsInput, mailIds } from "./ids.js"
export { decodedLabelName, decodeMailboxName, labelName, systemLabel } from "./labels.js"
export {
  acknowledgeMark,
  advancePastSkipped,
  type BulkExcerpt,
  cursorOf,
  HOLD_PARTIAL_MS,
  HOLDER,
  MARK_BATCH,
  type MailMark,
  type MailWaiting,
  type MarkedHit,
  type MarkRead,
  type MarkRewind,
  mailWaiting,
  markOf,
  marksOf,
  type RewoundMark,
  readPastMark,
  rewindMark,
  type SkipReason,
} from "./marks.js"
export {
  MEETING_NOTES,
  MEETING_NOTES_PROVIDERS,
  mailMeetingSource,
  notesOf,
  saveMeetingNotes,
} from "./meeting-notes.js"
export {
  BULK_TRIAGE_DEFAULTS,
  type BulkSorted,
  type BulkTriage,
  excerptOf,
  NEWSLETTER_DEFAULTS,
  NEWSLETTER_SENDERS,
  NEWSLETTER_WORDS,
  type NewsletterCues,
  newsletterSorter,
  ORDER_WORDS,
} from "./newsletter.js"
export { type MailTurn, mailTurn } from "./owed.js"
export {
  type Address,
  htmlToText,
  looksLikeHtml,
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  type ParsedMail,
  parseMail,
} from "./parse.js"
export { PARTIAL, type PartialOutcome } from "./partial.js"
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
export { isBulk, type MailReview, type MailReviewOptions, OWED_DAYS, REVIEW_THREADS, reviewMail } from "./review.js"
export { ruleInput, STORE_ACTION } from "./rule-input.js"
export { type MailRuleSet, storedMailRule, storedMailRuleSet, storedMailRules } from "./rule-stored.js"
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
export { SEARCH_REFUSED, searchRefused } from "./source.js"
export {
  MAIL_STATS_BY,
  type MailStats,
  type MailStatsBy,
  type MailStatsRequest,
  type MailStatsRow,
  mailStats,
  mailStatsItem,
} from "./stats.js"
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
export { readEmailWhole, type WholeAttachment } from "./whole.js"
