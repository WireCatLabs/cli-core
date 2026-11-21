export { type CrmFileFetchOptions, fetchCrmFile } from "./file-fetch.js"
export { crmFileId, LINK_REMOVED, parseCrmFileId, withoutFileLinks } from "./files.js"
export {
  DAILY_FOREIGN_CONTACTS,
  type ForeignContacts,
  foreignContacts,
  foreignContactsPathFor,
  refuseForeignClientReads,
} from "./foreign-contacts.js"
export {
  type CrmAfterHook,
  type CrmChangesCall,
  type CrmManifest,
  type CrmManifestEntity,
  type CrmManifestFields,
  type CrmManifestHooks,
  type CrmManifestPipelines,
  type CrmOperationCall,
  type CrmRule,
  parseCrmManifest,
} from "./manifest/manifest.js"
export { at as valueAt } from "./manifest/map.js"
export { crmManifestProblems } from "./manifest/paths.js"
export { type CrmManifestSourceOptions, crmSourceFromManifest } from "./manifest/source.js"
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
export {
  CRM_FILE_SOURCES,
  type CrmCallContext,
  type CrmChanges,
  type CrmCondition,
  type CrmFile,
  type CrmFileOwner,
  type CrmFileSourceKind,
  type CrmFiles,
  type CrmGap,
  type CrmIdPage,
  type CrmLiveKind,
  type CrmLiveQuery,
  type CrmOpenableFile,
  type CrmPage,
  type CrmSource,
  type CrmSourceTraits,
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
