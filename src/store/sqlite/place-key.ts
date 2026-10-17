import type { CacheDatabase } from "../driver.js"

/**
 * The confirmed place a value names: its own key, else the same street with no city (a place confirmed before
 * values carried the city), else, for a value with no city, the one place on that street. A value with a city never
 * links to the same street in another city.
 */
export const placeOf = (database: CacheDatabase) => {
  const exact = database.prepare("SELECT id FROM places WHERE folded = ?")
  const onStreet = database.prepare("SELECT id FROM places WHERE substr(folded, 1, ?) = ? LIMIT 2")
  return (value: string): number | undefined => {
    const street = value.split(", ")[0] ?? value
    const found = exact.get(value) ?? (street === value ? undefined : exact.get(street))
    if (found) return Number(found.id)
    if (street !== value) return undefined
    const same = onStreet.all(street.length + 2, `${street}, `)
    return same.length === 1 ? Number(same[0]?.id) : undefined
  }
}
