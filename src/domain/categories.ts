/** What an organization is to the owner, derived from relationships at read time and never stored. */
export const CATEGORIES = ["client", "supplier", "partner", "employer"] as const
export type Category = (typeof CATEGORIES)[number]
