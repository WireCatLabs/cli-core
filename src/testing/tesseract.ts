import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A stand-in for the tesseract program on PATH: its version, a failure and a picture with no text (`empty`) are files a
 * test changes between runs.
 */
export const fakeTesseract = () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-tesseract-"))
  const program = join(bin, "tesseract")
  writeFileSync(join(bin, "version"), "5.3.0")
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      `dir="${bin}"`,
      'case "$1" in',
      '  --version) echo "tesseract $(/bin/cat "$dir/version")" ;;',
      "  --list-langs) printf 'List of available languages (2):\\neng\\nrus\\n' ;;",
      '  *) [ -f "$dir/fail" ] && exit 1; /bin/cat > /dev/null; echo "$@" >> "$dir/calls"',
      '     [ -f "$dir/empty" ] || echo "scanneedle words" ;;',
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(program, 0o755)
  const calls = () => {
    try {
      return readFileSync(join(bin, "calls"), "utf8").trim().split("\n").filter(Boolean)
    } catch {
      return []
    }
  }
  return { bin, calls, reset: () => rmSync(join(bin, "calls"), { force: true }) }
}
