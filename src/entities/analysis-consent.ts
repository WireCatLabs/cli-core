import * as v from "valibot"
import { id, text, time } from "./fields.js"

export const analysisConsent = v.strictObject({ chat: id, provider: text, at: time })
export const analysisConsentRevocation = v.strictObject({ revoked: v.boolean() })
