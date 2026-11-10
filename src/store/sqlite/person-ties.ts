import { kindsOfEntry, providers } from "../../domain/providers.js"
import type { CacheDatabase } from "../driver.js"
import { mergedAwaySql } from "./merged-persons.js"
import { mergedAssignees } from "./task-board.js"

/**
 * A group this small is people the owner knows; in a bigger one an author alone is background. Store version 62's
 * trigger `person_kind_chat_au` holds the same number: changing it takes a migration that replaces that trigger.
 */
export const SMALL_GROUP_MEMBERS = 10

/** What ties a person to the owner, from what the store holds about them. */
export const PERSON_TIES = ["chat", "small-group", "mail", "meeting", "crm", "phone-book"] as const
export type PersonTie = (typeof PERSON_TIES)[number]

/** Why a person with no tie is still shown: the owner, someone added by hand, someone assigned a task. */
export const ALWAYS_SHOWN = ["owner", "added", "task"] as const
export type ShownBecause = (typeof ALWAYS_SHOWN)[number] | PersonTie

const crmProviders = (): string[] =>
  providers()
    .filter((entry) => kindsOfEntry(entry).includes("crm"))
    .map(({ name }) => name)

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`

/** A group of unknown size counts as large: hidden, rather than shown on a guess. */
const GROUP_SIZE =
  "coalesce(c.participants_count, (SELECT mc.listed_count FROM member_counts mc WHERE mc.chat_id = c.id " +
  "ORDER BY mc.date DESC LIMIT 1))"

/**
 * Telegram and WhatsApp keep no member list, so a chat's people are also whoever wrote in it (BUG-676). One pass over
 * the messages of dialogs and small groups, read through `messages_by_time`.
 */
const chatPeople = (where: string): string =>
  `SELECT m.identity_id FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE ${where} UNION ` +
  "SELECT s.sender_identity_id FROM chats c JOIN messages s ON s.chat_id = c.id " +
  `WHERE ${where} AND s.sender_identity_id IS NOT NULL AND s.outgoing IS NOT 1`

/**
 * NEED-2500 A: a CRM contact ties a person only when the CRM ties them to the owner, by a deal or lead whose owner is
 * the owner's person, so the owner's CRM user must be linked to the owner. The user a CRM sync signs in as is not the
 * owner: a portal's webhook may belong to a colleague. A CRM's users tie as before.
 */
// A deal's owner link names the person its CRM user had then; one merged into the owner since still counts.
const OWNERS_CRM_PEOPLE =
  "SELECT id FROM persons WHERE owner = 1 UNION SELECT e.from_person_id FROM identity_link_events e " +
  "JOIN identity_links l ON l.identity_id = e.identity_id JOIN persons p ON p.id = l.person_id AND p.owner = 1"

const crmTie = (crm: string[]): string => {
  if (crm.length === 0) return "SELECT NULL WHERE 0"
  const providers = crm.map(quoted).join(", ")
  return (
    `SELECT id FROM identities WHERE provider IN (${providers}) AND external_id LIKE '%/user/%' UNION ` +
    "SELECT l.identity_id FROM links d JOIN links o ON o.from_type = d.from_type AND o.from_id = d.from_id " +
    "AND o.kind = 'related-to' AND o.role = 'owner' AND o.to_type = 'person' AND o.deleted_at IS NULL " +
    "JOIN identity_links l ON l.person_id = d.to_id " +
    "WHERE d.from_type IN ('deal', 'lead') AND d.kind = 'related-to' AND d.to_type = 'person' AND d.role <> 'owner' " +
    `AND d.deleted_at IS NULL AND o.to_id IN (${OWNERS_CRM_PEOPLE})`
  )
}

/** Each tie as the identities that have it. */
const tieIdentities = (): Record<PersonTie, string> => {
  const crm = crmProviders()
  return {
    chat: chatPeople("c.kind = 'dialog'"),
    "small-group": chatPeople(`c.kind = 'group' AND ${GROUP_SIZE} <= ${SMALL_GROUP_MEMBERS}`),
    // NEED-2342 A: the owner wrote to them; mail they sent, a newsletter included, is no tie.
    mail:
      "SELECT r.identity_id FROM emails e JOIN email_recipients r ON r.email_id = e.id " +
      "WHERE e.outgoing = 1 AND e.deleted_at IS NULL AND e.draft IS NOT 1 AND r.identity_id IS NOT NULL",
    meeting:
      "SELECT identity_id FROM meeting_participants UNION ALL " +
      "SELECT identity_id FROM calendar_entry_participants WHERE resource = 0 AND identity_id IS NOT NULL",
    crm: crmTie(crm),
    "phone-book": "SELECT identity_id FROM account_identities WHERE address_book = 1",
  }
}

/**
 * One row per person and reason they are shown: each tie (a merged person has every tie of every identity on them),
 * the owner, a person added by hand (no identity, and not merged away), and a task's assignee, a merged-away one as
 * the person they are now. Takes the merged assignees (`mergedAssignees`) as its one parameter.
 */
const reasonRows = (): string =>
  [
    ...Object.entries(tieIdentities()).map(
      ([tie, identities]) =>
        `SELECT l.person_id AS person, '${tie}' AS tie FROM identity_links l WHERE l.identity_id IN (${identities})`,
    ),
    "SELECT entity_id, 'crm' FROM records WHERE entity_type = 'person' AND deleted_at IS NULL AND entity_id IS NOT NULL",
    "SELECT id, 'owner' FROM persons WHERE owner = 1",
    "SELECT p.id, 'added' FROM persons p WHERE NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = p.id) " +
      `AND NOT ${mergedAwaySql("p")}`,
    "SELECT coalesce(json_extract(m.value, '$[1]'), a.assignee_id), 'task' FROM task_assignments a " +
      "JOIN tasks t ON t.id = a.task_id AND t.deleted_at IS NULL " +
      "LEFT JOIN json_each(?) m ON json_extract(m.value, '$[0]') = a.assignee_id WHERE a.assignee_type = 'person'",
  ].join(" UNION ALL ")

const ORDER: readonly ShownBecause[] = [...ALWAYS_SHOWN, ...PERSON_TIES]

/**
 * Why each person is shown, in a fixed order; a person missing from the map has no tie and is hidden by default.
 * `people` narrows it to those. One pass over every tie: on 51,000 identities about 35 ms (cli-testing `performance/people/ties`).
 */
export const shownReasons = (database: CacheDatabase, people?: readonly number[]): Map<number, ShownBecause[]> => {
  const found = new Map<number, Set<ShownBecause>>()
  const only = people === undefined ? "" : " WHERE person IN (SELECT value FROM json_each(?))"
  for (const row of database
    .prepare(`SELECT DISTINCT person, tie FROM (${reasonRows()})${only}`)
    .all(mergedAssignees(database), ...(people === undefined ? [] : [JSON.stringify(people)]))) {
    const person = Number(row.person)
    const reasons = found.get(person) ?? new Set<ShownBecause>()
    reasons.add(row.tie as ShownBecause)
    found.set(person, reasons)
  }
  return new Map([...found].map(([person, reasons]) => [person, ORDER.filter((one) => reasons.has(one))]))
}
