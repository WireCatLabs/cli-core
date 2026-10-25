import { describe, expect, it } from "vitest"
import { authorOf, holderOf } from "./author.js"

describe("authorOf", () => {
  it("names each agent by its own variables, and the owner when none is set or --as-owner is given", () => {
    expect(authorOf({ CLAUDECODE: "1" })).toBe("claude-code")
    expect(authorOf({ AI_AGENT: "claude-code_2-1-310_agent" })).toBe("claude-code")
    expect(authorOf({ CODEX_THREAD_ID: "019a-thread" })).toBe("codex")
    expect(authorOf({ GEMINI_CLI: "1" })).toBe("gemini-cli")
    expect(authorOf({ CURSOR_AGENT: "1" })).toBe("cursor")
    expect(authorOf({ OPENCODE: "1" })).toBe("opencode")
    expect(authorOf({})).toBe("owner")
    expect(authorOf({ CODEX_THREAD_ID: "019a-thread" }, true)).toBe("owner")
  })
})

describe("holderOf", () => {
  it("names the session that claims: the flag, then WIRECAT_HOLDER, then the agent's session, then the agent", () => {
    const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s-1" }
    expect(holderOf({ ...claude, WIRECAT_HOLDER: "web-42" }, " chat-7 ")).toBe("chat-7")
    expect(holderOf({ ...claude, WIRECAT_HOLDER: "web-42" })).toBe("web-42")
    expect(holderOf(claude)).toBe("claude-code:s-1")
    expect(holderOf({ AI_AGENT: "codex_0-162_agent" })).toBe("codex")
    expect(holderOf({ CODEX_THREAD_ID: "019a-thread" })).toBe("codex:019a-thread")
    expect(holderOf({ OPENCODE: "1", OPENCODE_SESSION_ID: "ses_1" })).toBe("opencode:ses_1")
    expect(holderOf({ GEMINI_CLI: "1" })).toBe("gemini-cli")
    expect(holderOf({})).toBe("owner")
  })
})
