export {
  ACME_CALENDAR,
  ACME_MAIL,
  ACME_NOW,
  ACME_OPENED,
  ACME_PORTAL,
  ACME_TELEGRAM,
  type AcmeScenario,
  acmeScenario,
} from "./acme-scenario.js"
export {
  exampleDeal,
  exampleLead,
  exampleOrganization,
  examplePerson,
  FAKE_CRM_ALIASES,
  type FakeCrmSource,
  type FakeCrmSourceOptions,
  type FakeCrmWrite,
  fakeCrmSource,
  LEAD_PIPELINE,
  SALES_PIPELINE,
  SOURCE_FIELD,
} from "./source.js"
export { type CrmSourceFixture, crmSourceContract } from "./source-contract.js"
export { CRM_TRAIT_COMBINATIONS, type CrmSyncFixture, crmSyncContract } from "./sync-contract.js"
export { type CrmWriteFixture, crmWriteContract } from "./write-contract.js"
