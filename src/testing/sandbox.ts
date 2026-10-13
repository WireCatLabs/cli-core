import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"
// Every `openStore` loads Drizzle, about 200 ms from `node_modules`: loaded here, it is not charged to a test's timeout.
import "../store/sqlite/drizzle/node.js"

/** The shared store is the owner's system of record: a test that falls back to the default path would migrate it. */
const sandbox = mkdtempSync(join(tmpdir(), "cli-messaging-test-"))

process.env.MESSAGING_STORE = join(sandbox, "messages.db")
process.env.MESSAGING_STATE_DIR = join(sandbox, "state")
process.env.MESSAGING_CONFIG_DIR = join(sandbox, "config")
process.env.WIRECAT_STATE_DIR = join(sandbox, "cache")
// The apps the tests define: a failure is kept as a run, and a test without its own directories would keep it at home.
for (const prefix of ["APP", "CHAT", "TG", "MAX"]) {
  process.env[`${prefix}_STATE_DIR`] = join(sandbox, prefix, "state")
  process.env[`${prefix}_CONFIG_DIR`] = join(sandbox, prefix, "config")
  process.env[`${prefix}_CACHE_DIR`] = join(sandbox, prefix, "cache")
  process.env[`${prefix}_CACHE_DIR`] = join(sandbox, prefix, "cache")
  // Every test shares one profile's pace file: paced, a file of tests would wait on each other's calls.
  process.env[`${prefix}_REQUESTS_PER_MINUTE`] = "0"
  // No profile is ever assumed; a test that means "no profile named" passes its own env without this.
  process.env[`${prefix}_PROFILE`] = "default"
}
process.env.TMPDIR = sandbox
// The default folders when a test passes its own env without the *_DIR overrides: env-paths reads these from
// process.env, so a partial env would otherwise reach the owner's real ~/.cache.
process.env.HOME = join(sandbox, "home")
process.env.USERPROFILE = join(sandbox, "home")
for (const name of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "APPDATA", "LOCALAPPDATA"])
  process.env[name] = join(sandbox, "home", name.toLowerCase())
// Set in an agent's own shell, where it would make every run print the skill hint and read the real ~/.claude.
delete process.env.AI_AGENT
delete process.env.CLAUDECODE
for (const key of Object.keys(process.env)) {
  if (/^(APP|CHAT|TG|MAX)_(MODELS|EMBEDDING|ANALYSIS)_/.test(key)) delete process.env[key]
}

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))
