import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { provideInputPolicy } from "../cli/input-policy.js"
import { atTerminal, loginQr, PASTE_QR } from "./login-qr.js"
import { plainQr, terminalQr } from "./qr.js"

const LINK = "tg://login?token=not-a-real-token-for-the-test"

const SCAN = "scan in the app on your phone"

const capture = () => {
  const diagnostic: string[] = []
  const notes: string[] = []
  const log: [string, string][] = []
  return {
    diagnostic,
    notes,
    log,
    sinks: {
      diagnostic: (t: string) => {
        diagnostic.push(t)
        log.push(["diagnostic", t])
      },
      note: (t: string) => {
        notes.push(t)
        log.push(["note", t])
      },
    },
  }
}

describe("loginQr at a terminal", () => {
  it("draws the code on the diagnostic stream when the terminal is wide enough", () => {
    const { diagnostic, sinks } = capture()
    loginQr({ ...sinks, terminal: true, indent: 3, columns: () => 200 }).show(LINK)
    expect(diagnostic).toEqual([`\n${terminalQr(LINK).text.replace(/^/gm, "     ")}`])
  })

  it("says where to scan after the code is drawn", () => {
    const { log, sinks } = capture()
    loginQr({ ...sinks, terminal: true, columns: () => 200 }).show(LINK, SCAN)
    expect(log).toEqual([
      ["diagnostic", `\n${terminalQr(LINK).text.replace(/^/gm, "  ")}`],
      ["note", SCAN],
    ])
  })

  it("draws the code when the width is unknown", () => {
    const { diagnostic, sinks } = capture()
    loginQr({ ...sinks, terminal: true, columns: () => undefined }).show(LINK)
    expect(diagnostic[0]).toContain(terminalQr(LINK).text.split("\n")[1])
  })

  it("draws nothing on a narrow terminal and says only to widen it, on the stream --quiet keeps", () => {
    const { diagnostic, notes, sinks } = capture()
    let columns = 20
    const qr = loginQr({ ...sinks, terminal: true, columns: () => columns })

    expect(() => qr.show(LINK, SCAN)).not.toThrow()
    expect(diagnostic).toEqual([expect.stringMatching(/20 columns wide .* widen it$/)])
    expect(notes).toEqual([])

    columns = 200
    qr.show(LINK, SCAN)
    expect(diagnostic[1]).toContain(terminalQr(LINK).text.split("\n")[1])
    expect(notes).toEqual([SCAN])
  })
})

describe("loginQr without a terminal", () => {
  it("prints the code as plain text, whatever the width, then tells an agent to paste it and where to scan", () => {
    const { log, sinks } = capture()
    loginQr({ ...sinks, terminal: false, columns: () => 20 }).show(LINK, SCAN)
    expect(log).toEqual([
      ["diagnostic", `\n${plainQr(LINK)}\n`],
      ["note", PASTE_QR],
      ["note", SCAN],
    ])
    expect(log.join()).not.toContain("\x1b")
  })

  it("adds one JSON line per code in machine output, so a renewed code is read without scraping", () => {
    const { diagnostic, sinks } = capture()
    const qr = loginQr({ ...sinks, terminal: false, json: true })
    const expires = new Date("2026-10-19T10:00:30Z")

    qr.show(LINK, SCAN, expires)
    qr.show(`${LINK}-renewed`)

    const events = diagnostic.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
    expect(events).toEqual([
      { event: "qr", qr: { text: plainQr(LINK), expires_at: "2026-10-19T10:00:30.000Z", scan: SCAN } },
      { event: "qr", qr: { text: plainQr(`${LINK}-renewed`), expires_at: null, scan: null } },
    ])
  })
})

describe("atTerminal", () => {
  it("is a terminal that may be asked, and nothing else", () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true })
    expect(atTerminal(tty)).toBe(true)
    expect(atTerminal(new PassThrough())).toBe(false)
    const restore = provideInputPolicy(tty, { noInput: true })
    expect(atTerminal(tty)).toBe(false)
    restore()
  })
})
