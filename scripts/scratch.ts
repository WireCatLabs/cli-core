import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const made = new Set<string>()

export const scratch = (prefix: string): string => {
  if (!made.size)
    process.once("exit", () => {
      for (const dir of made)
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Windows keeps a loaded native module (resvg's .node) locked until the process has gone.
        }
    })
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.add(dir)
  return dir
}
