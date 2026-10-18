import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import { provideInputPolicy } from "../cli/input-policy.js"
import { atTerminal, loginQr, qrNeedsTerminal } from "./login-qr.js"
import { qrPng, terminalQr } from "./qr.js"

const LINK = "tg://login?token=not-a-real-token-for-the-test"

const capture = () => {
  const diagnostic: string[] = []
  const notes: string[] = []
  return {
    diagnostic,
    notes,
    sinks: { diagnostic: (t: string) => diagnostic.push(t), note: (t: string) => notes.push(t) },
  }
}

describe("loginQr", () => {
  it("writes the PNG with mode 600, replaces it on a renewed code, and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "login-qr-"))
    const path = join(dir, "login.png")
    writeFileSync(path, "an older, readable file", { mode: 0o644 })
    const { diagnostic, notes, sinks } = capture()
    const qr = loginQr({ qrFile: path, ...sinks })

    qr.show(LINK)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    qr.show(`${LINK}-renewed`)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path)).toEqual(Buffer.from(qrPng(`${LINK}-renewed`)))
    expect(readdirSync(dir)).toEqual(["login.png"])
    expect(diagnostic).toEqual([])
    expect(notes[0]).toContain(path)

    qr.close()
    expect(readdirSync(dir)).toEqual([])
  })

  it("draws the code on the diagnostic stream when the terminal is wide enough", () => {
    const { diagnostic, sinks } = capture()
    loginQr({ ...sinks, indent: 3, columns: () => 200 }).show(LINK)
    expect(diagnostic).toEqual([`\n${terminalQr(LINK).text.replace(/^/gm, "     ")}`])
  })

  it("draws the code when the width is unknown", () => {
    const { diagnostic, sinks } = capture()
    loginQr({ ...sinks, columns: () => undefined }).show(LINK)
    expect(diagnostic[0]).toContain(terminalQr(LINK).text.split("\n")[1])
  })

  it("draws nothing on a narrow terminal and says how to get the code, on the stream --quiet keeps", () => {
    const { diagnostic, notes, sinks } = capture()
    let columns = 20
    const qr = loginQr({ ...sinks, columns: () => columns })

    expect(() => qr.show(LINK)).not.toThrow()
    expect(diagnostic).toEqual([expect.stringMatching(/20 columns wide .* --qr-file <png>$/)])
    expect(notes).toEqual([])

    columns = 200
    qr.show(LINK)
    expect(diagnostic[1]).toContain(terminalQr(LINK).text.split("\n")[1])
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

describe("qrNeedsTerminal", () => {
  it("names the command and points at --qr-file", () => {
    const error = qrNeedsTerminal("tg personal session start")
    expect(error.message).toBe(
      "tg personal session start shows a QR code to scan — run it in a terminal, or pass --qr-file <png>",
    )
    expect(error.details).toMatchObject({ param: "--qr-file", reason: "input.required" })
  })
})
