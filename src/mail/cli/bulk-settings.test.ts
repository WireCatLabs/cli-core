import { describe, expect, it } from "vitest"
import { withSettingDefaults } from "../../cli/setting-defaults.js"
import { BULK_TRIAGE_DEFAULTS } from "../newsletter.js"
import { bulkTriageOf, MAIL_BULK_SETTINGS } from "./bulk-settings.js"

describe("the bulk-mail settings", () => {
  it("write the defaults the code applies, and read the owner's lists back", () => {
    const { config } = withSettingDefaults({}, MAIL_BULK_SETTINGS)
    expect(bulkTriageOf(config as Record<string, unknown>)).toEqual(BULK_TRIAGE_DEFAULTS)
    const owner = bulkTriageOf({ mail_bulk_newsletter_words: "акция, promo ,", mail_bulk_excerpts_per_read: 0 })
    expect(owner.cues.newsletterWords).toEqual(["акция", "promo"])
    expect(owner.perRead).toBe(BULK_TRIAGE_DEFAULTS.perRead)
  })
})
