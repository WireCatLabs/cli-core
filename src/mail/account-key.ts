import type { AccountKey } from "../store/index.js"

export const mailAccountKey = (address: string): AccountKey => ({ provider: "email", account: address.toLowerCase() })
