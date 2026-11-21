import { openProfileStore, type ProfileStoreOptions } from "../../cli/profile-store.js"

export type CrmStoreOptions = ProfileStoreOptions

/** The store a CRM command reads, and the profile's account in it (`openProfileStore`): a CRM is the owner's work. */
export const openCrmStore = openProfileStore
