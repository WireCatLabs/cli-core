import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { resolveOutput } from "./output.js"

describe("the output mode", () => {
  it("keeps text as written in JSON, invisible controls too", () => {
    const text = "a\u202e\u0085\ufeff\u{e0041}b"
    const raw = captureStreams()
    resolveOutput({ json: true, streams: raw }).renderer.result({ text })
    expect(JSON.parse(raw.stdout[0] as string).text).toBe(text)
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
