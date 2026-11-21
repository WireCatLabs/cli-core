import { openProfileStore, type ProfileStoreOptions } from "../../cli/profile-store.js"

export type ContentStoreOptions = ProfileStoreOptions

/** The store a content command reads, and the profile's account in it (`openProfileStore`). */
export const openContentStore = openProfileStore
