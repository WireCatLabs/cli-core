import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

/**
 * **Every test file runs with `TMPDIR` in a directory of its own, and the real keychain out of reach.**
 *
 * The config, credential, logging and update tests make their directories with
 * `mkdtempSync(join(tmpdir(), …))` and leave them — max-cli found fifteen thousand of those in
 * `/tmp`. `os.tmpdir()` reads `TMPDIR` on every call, so pointing it here and removing this
 * directory when the file is done cleans up after all of them.
 *
 * The keyring is injected everywhere, but `new Credentials({...})` without `keyring` falls back to
 * `systemKeyring`, and one test that forgets would write to the owner's real keychain — max-cli's
 * token lives there. `keyring.ts` loads `@napi-rs/keyring` through `createRequire`, which vitest's
 * `vi.mock` does not intercept, so the stand-in goes into the CommonJS require cache instead.
 */
const sandbox = mkdtempSync(join(tmpdir(), "cli-core-test-"))
process.env.TMPDIR = sandbox

export const REAL_KEYRING_REACHED = "a test reached the real OS keyring — pass memoryKeyring() instead"

const require = createRequire(import.meta.url)
const path = require.resolve("@napi-rs/keyring")
class Entry {
  constructor() {
    throw new Error(REAL_KEYRING_REACHED)
  }
}
require.cache[path] = {
  id: path,
  filename: path,
  loaded: true,
  exports: { Entry },
} as unknown as NodeJS.Module

afterAll(() => rmSync(sandbox, { recursive: true, force: true }))
