/** What an organization is to the owner, derived from relationships at read time and never stored (NEED-2377). */
export const CATEGORIES = ["client", "supplier", "partner", "employer"] as const
export type Category = (typeof CATEGORIES)[number]
