import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { CliError, indent, writeSecurely } from "@wirecat/cli-base"
import { inputPolicy } from "../cli/input-policy.js"
import { qrPng, terminalQr } from "./qr.js"

const MARGIN = 2

/** Whether a person can scan a code drawn here and answer what the login asks next. */
export const atTerminal = (input: NodeJS.ReadableStream & { isTTY?: boolean }): boolean =>
  input.isTTY === true && !inputPolicy(input).noInput

/** The one refusal of a QR login that nobody could scan. */
export const qrNeedsTerminal = (command: string): CliError =>
  new CliError(
    "validation_error",
    `${command} shows a QR code to scan — run it in a terminal, or pass --qr-file <png>`,
    {
      param: "--qr-file",
      reason: "input.required",
    },
  )

export interface LoginQrOptions {
  /** `--qr-file`: the PNG to write instead of drawing the code. */
  qrFile?: string
  /** Where the code and the narrow-terminal hint go; `--quiet` must not hide either. */
  diagnostic: (text: string) => void
  /** Where the file's location is said. */
  note: (text: string) => void
  /** How far the code sits right, to line up under a setup step. */
  indent?: number
  /** Read on every code, so a widened terminal draws the next one. Unknown draws the code. */
  columns?: () => number | undefined
}

export interface LoginQr {
  readonly path: string | undefined
  /** Never throws for a code that does not fit: the messengers call it from inside their own event loops. */
  show: (link: string) => void
  /** The image logs the account in while it is valid; call this in `finally`. */
  close: () => void
}

export const loginQr = ({
  qrFile,
  diagnostic,
  note,
  indent: pad = 0,
  columns = () => process.stderr.columns,
}: LoginQrOptions): LoginQr => {
  const path = qrFile === undefined ? undefined : resolve(qrFile)
  return {
    path,
    show: (link) => {
      if (path) {
        writeSecurely(path, qrPng(link), 0o600)
        note(`the QR code is in ${path} — it is replaced when the code renews`)
        return
      }
      const drawn = terminalQr(link)
      const need = drawn.width + pad + MARGIN
      const width = columns()
      if (width !== undefined && need > width) {
        diagnostic(
          `the terminal is ${width} columns wide and the QR code needs ${need} — widen it, ` +
            "or run again with --qr-file <png>",
        )
        return
      }
      diagnostic(`\n${indent(drawn.text, pad + MARGIN)}`)
    },
    close: () => {
      if (path) rmSync(path, { force: true })
    },
  }
}
