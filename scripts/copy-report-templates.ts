import { cpSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
cpSync(join(root, "src/background/report/templates"), join(root, "dist/background/report/templates"), {
  recursive: true,
})
