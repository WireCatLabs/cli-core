import { describe, expect, it } from "vitest"
import { withoutSecrets } from "./secrets.js"

// Built at runtime so no literal here looks like a live key to the repository's own secret scanner.
const x = (count: number) => "x".repeat(count)
const random20 = ["Kz9v", "Q2mX", "7pL4", "nR8t", "W1yB"].join("")

describe("withoutSecrets", () => {
  it("hides tokens of known vendor formats anywhere in the text", () => {
    const tokens = [
      `ghp_${x(36)}`,
      `gho_${x(36)}`,
      `github_pat_${x(30)}`,
      `sk-${x(24)}`,
      `sk-ant-api03-${x(24)}`,
      `xoxb-${x(12)}`,
      `AKIA${"X".repeat(16)}`,
      `ASIA${"X".repeat(16)}`,
      `AIza${x(35)}`,
      `sk_live_${x(24)}`,
      `rk_live_${x(24)}`,
      `npm_${x(36)}`,
      `123456789:${x(35)}`,
      `eyJ${x(10)}.eyJ${x(10)}.${x(10)}`,
    ]
    for (const token of tokens) expect(withoutSecrets(`use ${token}, then`)).toBe("use [redacted], then")
    expect(withoutSecrets(`https://api.telegram.org/bot123456789:${x(35)}/getMe`)).toBe(
      "https://api.telegram.org/bot[redacted]/getMe",
    )
    expect(withoutSecrets(`pk_live_${x(24)}`)).toBe(`pk_live_${x(24)}`)
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${x(64)}\n-----END RSA PRIVATE KEY-----`
    expect(withoutSecrets(`key: ${pem} done`)).toBe("key: [redacted] done")
  })

  it("keeps the name and hides the value of a secret-named pair, and a Bearer or Basic credential", () => {
    expect(withoutSecrets("password=hunter2")).toBe("password=[redacted]")
    expect(withoutSecrets("API_TOKEN=abc123 next")).toBe("API_TOKEN=[redacted] next")
    expect(withoutSecrets("client_secret:abc")).toBe("client_secret:[redacted]")
    expect(withoutSecrets('{"accessToken":"abc"}')).toBe('{"accessToken":"[redacted]"}')
    expect(withoutSecrets("https://x.io/cb?access_token=abc&state=1")).toBe(
      "https://x.io/cb?access_token=[redacted]&state=1",
    )
    expect(withoutSecrets("my password: hunter2")).toBe("my password: [redacted]")
    expect(withoutSecrets("Authorization: Bearer abcdefgh1")).toBe("Authorization: Bearer [redacted]")
    expect(withoutSecrets("Basic dXNlcjpwYXNz")).toBe("Basic [redacted]")
    expect(withoutSecrets("tokenizer=bert keyboard=us")).toBe("tokenizer=bert keyboard=us")
  })

  it("hides a random-looking string of twenty characters or more", () => {
    expect(withoutSecrets(random20)).toBe("[redacted]")
    expect(withoutSecrets(`key=${random20}`)).toBe("key=[redacted]")
    expect(withoutSecrets(`(${random20})`)).toBe("([redacted])")
    expect(withoutSecrets("Kz9v/Q2mX+7pL4nR8tW1yB==")).toBe("[redacted]==")
  })

  it("keeps words, names, ids, hashes, paths and URLs", () => {
    const kept = [
      "the Basic plan is fine, see you at 5",
      "InlineQueryResultCachedMpeg4Gif",
      "getUpdatesWithTimeout2025",
      "MESSAGING_LIMIT_TIER_0",
      "SyntheticDocument_000123",
      "mmarco-mMiniLMv2-L12-H384-v1",
      "iPhone15ProMax-256GB-Blue",
      "WireCatLabs-cli-core-pr-2036",
      "Release-v0.440.0-candidate",
      "550e8400-e29b-41d4-a716-446655440000",
      "550E8400-E29B-41D4-A716-446655440000",
      "3EB0C767D26A1D8F5E2C6B",
      "a81f2c9",
      "0123456789abcdef0123456789abcdef012345",
      "20260920T084431Z-chats-list-a81f2c",
      "2026-01-03T09:05:12.000Z",
      "/home/anna/Projects/AI/cli-core-wt-secret-detect/src/runs/run-context.ts",
      "./Documents/Q3-2026-Revenue-Forecast-v2.xlsx",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://docs.google.com/document/d/1SyntheticFileId_abc-XYZ0123456789/edit",
      "Привет, это пароль от вайфая? 🙂 Встречаемся в 17:00",
      "risk-assessment-2026 desk-lamp-overview-and-notes",
    ]
    for (const text of kept) expect(withoutSecrets(text)).toBe(text)
  })
})
