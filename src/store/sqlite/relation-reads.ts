import type { StoreContext } from "./open.js"
import { type RelationList, relationListOver } from "./relation-list.js"
import { type RelationRoles, relationRolesOver } from "./relation-roles.js"

export { checkStoredRole } from "./relation-roles.js"

/** The knowledge store's relationship reads: the filtered list and the role lists. */
export interface RelationReads extends RelationList, RelationRoles {}

export const relationReadsOver = (context: StoreContext): RelationReads => ({
  ...relationListOver(context),
  ...relationRolesOver(context),
})
