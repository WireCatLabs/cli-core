import { describe, expect, it } from "vitest"
import { type DeclaredSetting, settingRows, withSettingDefaults } from "./setting-defaults.js"

const declared: DeclaredSetting[] = [
  { key: "agent_decisions", default: false, description: "an agent may decide for the owner" },
  { key: "update_check", default: true, description: "check once a day for a newer version" },
  { key: "auto.every", default: "5m", description: "how often the timer runs" },
  { key: "mail.max_body_chars", default: 1_000_000, description: "the most characters of a body kept" },
]

describe("declared setting defaults", () => {
  it("adds what the file lacks after the owner's keys, and keeps the owner's values, order and unknown keys", () => {
    const raw = { zeta: 1, update_check: false, auto: { places: { A: "b" } }, agent_decisions: true }
    const { config, added } = withSettingDefaults(raw, declared)
    expect(JSON.stringify(config)).toBe(
      JSON.stringify({
        zeta: 1,
        update_check: false,
        auto: { places: { A: "b" }, every: "5m" },
        agent_decisions: true,
      }),
    )
    expect(added).toEqual(["auto.every"])
    expect(raw.auto).toEqual({ places: { A: "b" } })
  })

  it("fills a missing file but creates no section, since a section may need fields no default gives", () => {
    expect(withSettingDefaults(undefined, declared)).toEqual({
      config: { agent_decisions: false, update_check: true },
      added: ["agent_decisions", "update_check"],
    })
  })

  it("lists every declared setting with its value, default and whether the file says it", () => {
    expect(settingRows({ update_check: false }, declared)).toEqual([
      {
        setting: "agent_decisions",
        value: false,
        default: false,
        from: "default",
        description: "an agent may decide for the owner",
      },
      {
        setting: "update_check",
        value: false,
        default: true,
        from: "config file",
        description: "check once a day for a newer version",
      },
      { setting: "auto.every", value: "5m", default: "5m", from: "default", description: "how often the timer runs" },
      {
        setting: "mail.max_body_chars",
        value: 1_000_000,
        default: 1_000_000,
        from: "default",
        description: "the most characters of a body kept",
      },
    ])
  })
})
