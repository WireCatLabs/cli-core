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
} from "./source.js"
export { type CrmSourceFixture, crmSourceContract } from "./source-contract.js"
export { CRM_TRAIT_COMBINATIONS, type CrmSyncFixture, crmSyncContract } from "./sync-contract.js"
export { type CrmWriteFixture, crmWriteContract } from "./write-contract.js"
