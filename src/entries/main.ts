// `.`: the stable API and, marked experimental, the areas that were experimental entry points before 3.0. Two areas
// name different types alike and `export *` drops such a name, so the type lists pick one and rename the other.
// `cli-dev api-report` keeps the last mark of a name both stars reach, and the stable star sorts last.

/** @experimental */
export type {
  Attachment as MeetingAttachment,
  Finding as MeetingFinding,
  Transcript as MeetingTranscript,
} from "../meetings/index.js"
/** @experimental */
export type { TokenStorage as OAuthTokenStorage } from "../oauth/index.js"
/** @experimental */
export type { GroupMember as GroupContextMember } from "../services/index.js"
/** @experimental */
export * from "./main-experimental.js"
export type { Attachment, Finding, GroupMember, TokenStorage, Transcript } from "./main-stable.js"
export * from "./main-stable.js"
