import { describe, expect, it } from "vitest"
import { holderOf } from "./author.js"

describe("holderOf", () => {
  it("names the session that claims: the flag, then WIRECAT_HOLDER, then Claude Code's session, then the agent", () => {
    const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-1" }
    expect(holderOf({ ...claude, WIRECAT_HOLDER: "web-42" }, " chat-7 ")).toBe("chat-7")
    expect(holderOf({ ...claude, WIRECAT_HOLDER: "web-42" })).toBe("web-42")
    expect(holderOf(claude)).toBe("claude-code:s-1")
    expect(holderOf({ AI_AGENT: "codex_0-162_agent" })).toBe("codex")
    expect(holderOf({})).toBe("owner")
  })
})
