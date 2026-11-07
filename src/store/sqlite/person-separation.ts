import type { StoreContext } from "./open.js"

interface Side {
  identities: readonly number[]
  person?: number
}

const identitiesOf = ({ database }: StoreContext, person: number): number[] =>
  database
    .prepare("SELECT identity_id AS pk FROM identity_links WHERE person_id = ?")
    .all(person)
    .map(({ pk }) => Number(pk))

const MOVED_AWAY = `moved.identity_id IN (SELECT value FROM json_each(?))
  AND (moved.from_person_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM identity_link_events held WHERE held.to_person_id = moved.from_person_id
      AND held.identity_id IN (SELECT value FROM json_each(?))))`

/**
 * The owner once moved an identity of one side out of the other side's person, or out of a person that held an
 * identity of the other side. Checked over whole people because a merge moves whole people: a pair check lets a
 * third identity carry two separated people back together.
 */
const apart = ({ database }: StoreContext, one: Side, other: Side): boolean => {
  const ids = (side: Side) => JSON.stringify(side.identities)
  const person = (side: Side) => JSON.stringify(side.person === undefined ? [] : [side.person])
  return (
    database
      .prepare(`SELECT 1 FROM identity_link_events moved WHERE moved.author = 'owner'
        AND ((${MOVED_AWAY}) OR (${MOVED_AWAY})) LIMIT 1`)
      .get(ids(one), person(other), ids(other), ids(other), person(one), ids(one)) !== undefined
  )
}

/** Whether the owner separated anyone of `one` from anyone of `other`; nothing automatic may join them again. */
export const separated = (context: StoreContext, one: number, other: number): boolean =>
  one !== other &&
  apart(
    context,
    { identities: identitiesOf(context, one), person: one },
    { identities: identitiesOf(context, other), person: other },
  )

/** Whether the owner separated this one identity from `person` or from anyone of it. */
export const identitySeparated = (context: StoreContext, identity: number, person: number): boolean =>
  apart(
    context,
    { identities: [identity] },
    { identities: identitiesOf(context, person).filter((pk) => pk !== identity), person },
  )
