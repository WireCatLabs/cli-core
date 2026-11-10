/** The people the shared contract seed (`src/kit/seed.ts`) makes, so a test run that reached a real store shows. */
export const SEED_PEOPLE = [
  { name: "Owner", username: "owner" },
  { name: "Ann Lee", username: "ann" },
  { name: "Bob Ray", username: null },
] as const

/** Domains no real mailbox has (RFC 2606 and RFC 6761), as SQLite `GLOB` patterns over a lower-cased address. */
export const RESERVED_ADDRESS_GLOBS = [
  "*@example.com",
  "*@example.net",
  "*@example.org",
  "*.example",
  "*.test",
  "*.invalid",
  "*.localhost",
] as const

/** Ids made by the seed's `wordIds`; numeric ids are real for some providers, so `digitIds` are not counted. */
export const SEED_ID_GLOBS = ["person-[0-9]*"] as const
