import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const made = new Set<string>()

export const scratch = (prefix: string): string => {
  if (!made.size)
    process.once("exit", () => {
      for (const dir of made) rmSync(dir, { recursive: true, force: true })
    })
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}
