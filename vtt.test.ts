import { describe, expect, it } from "vitest"
import { parseVtt, VttError } from "./vtt.js"

const zoom = `WEBVTT

00:00:01.500 --> 00:00:04.000
Alice Example: Shall we start?

00:00:04.000 --> 00:01:02.250
Bob Sample: Yes. The plan: ship on Friday.
`

describe("parseVtt", () => {
  it("reads Zoom's unnumbered cues with the speaker inline", () => {
    expect(parseVtt(zoom)).toEqual([
      { startMs: 1500, endMs: 4000, speaker: "Alice Example", text: "Shall we start?" },
      { startMs: 4000, endMs: 62250, speaker: "Bob Sample", text: "Yes. The plan: ship on Friday." },
    ])
  })

  it("skips cue ids, NOTE and STYLE blocks, and timing settings", () => {
    const vtt =
      "WEBVTT - a title\n\nNOTE\nnot a cue\n\nSTYLE\n::cue {}\n\n7\n01:00:00.000 --> 01:00:01.000 align:start\nCarol Test: hi\n"
    expect(parseVtt(vtt)).toEqual([{ startMs: 3_600_000, endMs: 3_601_000, speaker: "Carol Test", text: "hi" }])
  })

  it("skips header lines after WEBVTT", () => {
    expect(parseVtt("WEBVTT\nKind: captions\nLanguage: en\n\n00:00:01.000 --> 00:00:02.000\nhi\n")).toEqual([
      { startMs: 1000, endMs: 2000, speaker: null, text: "hi" },
    ])
    expect(parseVtt("WEBVTT")).toEqual([])
  })

  it("takes a byte-order mark, CRLF line ends and minutes-only timestamps", () => {
    expect(parseVtt("﻿WEBVTT\r\n\r\n00:02.000 --> 00:03.000\r\nAlice Example: ok\r\n")).toEqual([
      { startMs: 2000, endMs: 3000, speaker: "Alice Example", text: "ok" },
    ])
  })

  it("keeps a multi-line cue whole and finds the speaker on its first line only", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nno speaker here\nwhile: this is text\n"
    expect(parseVtt(vtt)).toEqual([
      { startMs: 0, endMs: 2000, speaker: null, text: "no speaker here\nwhile: this is text" },
    ])
  })

  it("refuses a file that is not WebVTT", () => {
    expect(() => parseVtt("1\n00:00:00,000 --> 00:00:01,000\nhi\n")).toThrow(VttError)
  })

  it("names the line of a broken timestamp or a cue with no timing", () => {
    expect(() => parseVtt("WEBVTT\n\n00:00:00 --> 00:00:01.000\nhi\n")).toThrow(/line 3/)
    expect(() => parseVtt("WEBVTT\n\njust text\nmore text\nand more\n")).toThrow(/line 3: a cue has no timing/)
  })
})
