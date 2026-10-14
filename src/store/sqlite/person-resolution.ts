import type { CacheDatabase } from "../driver.js"
import { fold } from "../normalize.js"

const keyOf = (name: string) => fold(name).trim().replace(/^@/, "")

export const resolvePersonLinks = (database: CacheDatabase, names: (string | null | undefined)[]): void => {
  for (const key of new Set(names.filter((name): name is string => !!name?.trim()).map(keyOf))) {
    if (!database.prepare("SELECT 1 FROM links WHERE to_id IS NULL AND target_folded=? LIMIT 1").get(key)) continue
    const people = new Set<number>()
    for (const row of database
      .prepare(
        "SELECT i.name, i.username, il.person_id FROM identities i JOIN identity_links il ON il.identity_id=i.id " +
          "WHERE il.person_id IS NOT NULL",
      )
      .all()) {
      if ([row.name, row.username].some((name) => name != null && keyOf(String(name)) === key))
        people.add(Number(row.person_id))
    }
    for (const row of database
      .prepare(
        "SELECT a.name, il.person_id FROM aliases a JOIN identity_links il ON il.identity_id=a.aliasable_id WHERE a.aliasable_type='identity' AND il.person_id IS NOT NULL UNION ALL SELECT name, aliasable_id AS person_id FROM aliases WHERE aliasable_type='person'",
      )
      .all())
      if (keyOf(String(row.name)) === key) people.add(Number(row.person_id))
    if (people.size === 1)
      database
        .prepare("UPDATE links SET to_type='person', to_id=? WHERE to_id IS NULL AND target_folded=?")
        .run([...people][0] as number, key)
  }
}
