import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { resolveOutput } from "./output.js"

describe("the output mode", () => {
  it("opts agents into visible controls without changing ordinary JSON", () => {
    const text = "a\u202e\u0085\ufeff\u{e0041}b"
    const raw = captureStreams()
    resolveOutput({ json: true, streams: raw }).renderer.result({ text })
    expect(JSON.parse(raw.stdout[0] as string).text).toBe(text)
    const safe = captureStreams()
    resolveOutput({ agentJson: true, tty: true, streams: safe }).renderer.result({ text })
    expect(JSON.parse(safe.stdout[0] as string).text).toBe("a\\u202e\\x85\\ufeff\\u{e0041}b")
    expect(safe.stderr).toEqual([])
  })

  it("guards each JSONL item and preserves whole subdivision flags", () => {
    const flag =
      "\u{1f3f4}" +
      "gbeng"
        .split("")
        .map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0)))
        .join("") +
      "\u{e007f}"
    const streams = captureStreams()
    resolveOutput({ agentJson: true, jsonl: true, streams }).renderer.stream([{ text: flag }, { text: "\u202e" }])
    expect(streams.stdout.map((line) => JSON.parse(line).text)).toEqual([flag, "\\u202e"])
  })

  it("writes one JSON value to stdout and nothing to stderr when piped", () => {
    const streams = captureStreams()
    resolveOutput({ streams, tty: false }).renderer.result({ items: [{ id: "1" }], hasMore: false })

    expect(streams.stdout).toEqual(['{"items":[{"id":"1"}],"hasMore":false}'])
    expect(streams.stderr).toEqual([])
  })

  it("keeps a chat title on one line for a person, and a message text as written", () => {
    const streams = captureStreams()
    resolveOutput({ streams, tty: true, color: false }).renderer.result({ title: "a\nb", text: "c\nd" })

    expect(streams.stdout.join("\n")).toContain("a\\x0ab")
    expect(streams.stdout.join("\n")).toContain("c\nd")
  })

  it("silences notes under --quiet but still says a failure", () => {
    const streams = captureStreams()
    const { renderer } = resolveOutput({ streams, tty: false, quiet: true })
    renderer.note("working")
    renderer.failure("no chat matches")

    expect(streams.stderr).toEqual(["no chat matches"])
  })
})

it("uses quiet terminal defaults in CI, TERM=dumb and NO_COLOR; machine mode never paints", () => {
  for (const env of [{ CI: "1" }, { TERM: "dumb" }, { NO_COLOR: "1" }])
    expect(resolveOutput({ tty: true, env }).color).toBe(false)
  expect(resolveOutput({ tty: true, env: {}, color: true }).color).toBe(true)
  expect(resolveOutput({ tty: true, env: { FORCE_COLOR: "1" }, json: true, color: true }).color).toBe(false)
})
