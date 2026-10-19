import { indent } from "@wirecat/cli-base"
import { inputPolicy } from "../cli/input-policy.js"
import { plainQr, terminalQr } from "./qr.js"

const MARGIN = 2

/** Whether a person can scan a code drawn here and answer what the login asks next. */
export const atTerminal = (input: NodeJS.ReadableStream & { isTTY?: boolean }): boolean =>
  input.isTTY === true && !inputPolicy(input).noInput

/** What an agent reads off the plain-text code: the same words a person reads under the drawn one. */
export const PASTE_QR =
  "agents: paste the QR code above into the chat as a code block, exactly as printed; " +
  "when a new one is printed, paste it and say the old one expired"

export interface LoginQrOptions {
  /** Where the code and the narrow-terminal hint go; `--quiet` must not hide either. */
  diagnostic: (text: string) => void
  /** Where where-to-scan and the agent's instruction go. */
  note: (text: string) => void
  /** How far the code sits right, to line up under a setup step. */
  indent?: number
  /** Read on every code, so a widened terminal draws the next one. Unknown draws the code. */
  columns?: () => number | undefined
  /**
   * Whether a person reads the diagnostic stream in a terminal. Off one, the code is plain text for an agent to
   * paste into the chat (`plainQr`). Defaults to whether stderr is a terminal.
   */
  terminal?: boolean
  /**
   * Machine output (`--json`, `--jsonl`, or no terminal): each code is also one JSON line on the diagnostic stream,
   * `{"event":"qr","qr":{"text","expires_at","scan"}}`. stdout keeps only the answer, which comes after the scan.
   */
  json?: boolean
}

export interface LoginQr {
  /**
   * `scan` says where to scan; it follows the code, and is not said when the terminal is too narrow to draw one.
   * Never throws for a code that does not fit: the messengers call it from inside their own event loops.
   */
  show: (link: string, scan?: string, expiresAt?: Date) => void
}

export const loginQr = ({
  diagnostic,
  note,
  indent: pad = 0,
  columns = () => process.stderr.columns,
  terminal = process.stderr.isTTY === true,
  json = false,
}: LoginQrOptions): LoginQr => ({
  show: (link, scan, expiresAt) => {
    if (!terminal) {
      const text = plainQr(link)
      diagnostic(`\n${text}\n`)
      if (json)
        diagnostic(
          JSON.stringify({
            event: "qr",
            qr: { text, expires_at: expiresAt?.toISOString() ?? null, scan: scan ?? null },
          }),
        )
      note(PASTE_QR)
      if (scan) note(scan)
      return
    }
    const drawn = terminalQr(link)
    const need = drawn.width + pad + MARGIN
    const width = columns()
    if (width !== undefined && need > width) {
      diagnostic(`the terminal is ${width} columns wide and the QR code needs ${need} — widen it`)
      return
    }
    diagnostic(`\n${indent(drawn.text, pad + MARGIN)}`)
    if (scan) note(scan)
  },
})
