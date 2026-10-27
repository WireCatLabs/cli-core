import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { activityRecorder, calledTools, localDay, readActivity } from "./activity.js"

const fileIn = () => join(mkdtempSync(join(tmpdir(), "mcp-activity-")), "mcp-http", "all.activity.json")

describe("what a logged-in app did", () => {
  it("finds the tools a body calls, in a batch too, and drops names that are not a tool's", () => {
    const call = (name: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } })
    expect(calledTools(call("tg_read"))).toEqual(["tg_read"])
    expect(calledTools([call("tg_read"), { method: "tools/list" }, call("tg_send")])).toEqual(["tg_read", "tg_send"])
    expect(calledTools(call("<script>"))).toEqual([])
    expect(calledTools(call("x".repeat(65)))).toEqual([])
    expect(calledTools(call(42))).toEqual([])
    expect(calledTools(null)).toEqual([])
  })

  it("writes a call at once with its name and time only, mode 600, and counts calls per local day", () => {
    const file = fileIn()
    let at = new Date(2026, 9, 27, 10, 0).getTime()
    const recorder = activityRecorder(file, () => at)

    recorder.record("client-a", ["tg_read"])
    at += 60_000
    recorder.record("client-a", ["tg_search"])

    expect(readActivity(file)["client-a"]).toEqual({
      lastRequestAt: new Date(at).toISOString(),
      lastTool: "tg_search",
      lastToolAt: new Date(at).toISOString(),
      day: localDay(at),
      toolCalls: 2,
    })
    expect(statSync(file).mode & 0o777).toBe(0o600)

    at = new Date(2026, 9, 28, 9, 0).getTime()
    recorder.record("client-a", ["tg_read"])
    expect(readActivity(file)["client-a"]?.toolCalls).toBe(1)
  })

  it("keeps the last call when later requests call nothing, and writes those on flush", () => {
    const file = fileIn()
    let at = new Date(2026, 9, 27, 10, 0).getTime()
    const recorder = activityRecorder(file, () => at)
    recorder.record("client-a", ["tg_read"])
    const called = at
    at += 5000
    recorder.record("client-a", [])
    expect(readActivity(file)["client-a"]?.lastRequestAt).toBe(new Date(called).toISOString())

    recorder.flush()

    expect(readActivity(file)["client-a"]).toMatchObject({
      lastRequestAt: new Date(at).toISOString(),
      lastTool: "tg_read",
      lastToolAt: new Date(called).toISOString(),
      toolCalls: 1,
    })
    expect(readFileSync(file, "utf8")).not.toMatch(/arguments/)
  })

  it("reads a missing or broken file as nothing", () => {
    expect(readActivity(fileIn())).toEqual({})
  })
})
