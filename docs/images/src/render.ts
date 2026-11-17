// Renders banner.html to the README banner. Run from anywhere: node docs/images/src/render.ts
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome"
const SOURCE = fileURLToPath(new URL("banner.html", import.meta.url))
const OUTPUT = fileURLToPath(new URL("../cli-core-banner.png", import.meta.url))

// A throwaway profile, so the render never opens the owner's Chrome profile.
const profile = mkdtempSync(join(tmpdir(), "banner-chrome-"))
const result = spawnSync(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1280,640",
    `--user-data-dir=${profile}`,
    `--screenshot=${OUTPUT}`,
    pathToFileURL(SOURCE).href,
  ],
  { stdio: "inherit" },
)
process.exitCode = result.status ?? 1
