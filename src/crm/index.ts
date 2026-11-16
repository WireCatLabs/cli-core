export {
  DAILY_FOREIGN_CONTACTS,
  type ForeignContacts,
  foreignContacts,
  foreignContactsPathFor,
  refuseForeignClientReads,
} from "./foreign-contacts.js"
export { type ProviderCallOptions, providerCall } from "./provider-call.js"
export {
  type CrmConditionHooks,
  type CrmQueryField,
  conditionsOf,
  customConditions,
  customNames,
  filterableFields,
  selectedCodes,
  wantedCodes,
  withCustomFields,
} from "./query.js"
export type {
  CrmCallContext,
  CrmChanges,
  CrmCondition,
  CrmGap,
  CrmIdPage,
  CrmLiveKind,
  CrmLiveQuery,
  CrmPage,
  CrmSource,
  CrmSourceTraits,
} from "./source.js"
export {
  type CrmCursor,
  type CrmSyncIssue,
  type CrmSyncOptions,
  type CrmSyncReport,
  type CrmSyncResult,
  crmGapsOf,
  crmStatus,
  cursorName,
  parseCrmCursor,
  syncCrm,
} from "./sync.js"
/** An adapter's readers of a CRM's raw JSON: `crmValues.text(raw.name)`, `crmValues.time(raw.created_at)`. */
export * as crmValues from "./values.js"
export { type CrmViewing, crmViewerOf, withReadableDeal } from "./viewer.js"
export { type CrmRows, type CrmWindow, crmWindowOf, walk } from "./walk.js"
export {
  CRM_ASSIGN_OTHERS_KEY,
  CRM_VERBS,
  CRM_WRITE_DEFAULTS,
  CRM_WRITE_KEYS,
  type CrmDraft,
  type CrmDrafts,
  type CrmFields,
  type CrmOrganizationFields,
  type CrmPersonFields,
  type CrmVerb,
  type CrmWriteCapabilities,
  type CrmWriteFields,
  type CrmWriteOptions,
  type CrmWriter,
  crmAlsoChecks,
} from "./writer.js"
export {
  type CrmFieldsInput,
  type CrmRecordInput,
  type CrmRecordKind,
  type CrmRecordWritten,
  type CrmWriteContext,
  type CrmWrites,
  type CrmWritten,
  closeCrmItem,
  createCrmItem,
  createCrmRecord,
  crmCustomValues,
  fieldNamed,
  fieldPairsOf,
  foldFieldName,
  moveCrmItem,
  type NamedField,
  optionOf,
  removeCrmItem,
  unknownField,
  updateCrmItem,
  updateCrmRecord,
} from "./writes.js"
