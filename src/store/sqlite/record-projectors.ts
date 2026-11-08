import type { RecordProjectors } from "./record-projection.js"
import { DIRECT_PROJECTORS } from "./record-projectors-direct.js"
import { MONEY_PROJECTORS } from "./record-projectors-money.js"
import { PHONE_PROJECTORS } from "./record-projectors-phone.js"

/** One projector per registered type; `null` for the types whose entity is matched or made from identifiers. */
export const RECORD_PROJECTORS: RecordProjectors = {
  ...MONEY_PROJECTORS,
  ...DIRECT_PROJECTORS,
  ...PHONE_PROJECTORS,
  person: null,
  organization: null,
  project: null,
}
