import { CliError } from "@wirecat/cli-base"
import type { BotButton } from "./port.js"

/** Telegram's limits; MAX's are looser, so one check serves both. */
const MAX_DATA_BYTES = 64
const MAX_BUTTONS = 8

/** `--field` values, `<text>=<data>` each, as one row; the text may not hold `=`, the data may. */
export const parseButtons = (values: readonly string[]): BotButton[][] => {
  if (values.length > MAX_BUTTONS) {
    throw new CliError("validation_error", `at most ${MAX_BUTTONS} buttons fit in a row; got ${values.length}`)
  }
  const row = values.map((value) => {
    const cut = value.indexOf("=")
    const text = (cut < 0 ? value : value.slice(0, cut)).trim()
    const data = cut < 0 ? "" : value.slice(cut + 1)
    if (cut < 0 || text === "") {
      throw new CliError("validation_error", `--field wants <text>=<data>, got "${value}"`)
    }
    const bytes = Buffer.byteLength(data, "utf8")
    if (bytes < 1 || bytes > MAX_DATA_BYTES) {
      throw new CliError(
        "validation_error",
        `--field "${text}": the callback data must be 1 to ${MAX_DATA_BYTES} bytes, got ${bytes}`,
      )
    }
    return { text, data }
  })
  return row.length === 0 ? [] : [row]
}
