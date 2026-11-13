import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface SyncAfterInstallCase {
  name: string
  /** Throws an `AssertionError` when the command is refused or fails. */
  run(): Promise<void>
}

export interface SyncAfterInstallOptions {
  /** The words that sync a signed-in profile against the CLI's fake service: `["work", "sync"]`. */
  sync: readonly string[]
  /**
   * Runs the CLI as its own tests do, against its fake service, with `env` laid over the test's environment. A CLI
   * on cli-core's program passes `run(argv, definition, { ...fakes, env: { ...process.env, ...env } })`.
   */
  run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; err: string; out?: string }>
  /** Words of a local-only change that the "read only" answer must still refuse, as a check it opens no more. */
  refusedUnderReadOnly?: readonly string[]
}

/**
 * The shared config (`~/.config/WireCat/config.json`) as a fresh or damaged machine has it. Only an explicit
 * "read only" answer limits a tool, and even then a sync runs: it only reads the service (owner ruling, 2026-11-13).
 */
const SHARED_CONFIGS: { state: string; write?: (dir: string) => void; readOnly?: true }[] = [
  { state: "no shared config, as on a fresh install" },
  { state: "a shared config that is not JSON", write: (dir) => writeFileSync(join(dir, "config.json"), "{ setup: ") },
  {
    state: "a shared config with a byte-order mark",
    write: (dir) => writeFileSync(join(dir, "config.json"), '﻿{"setup":{"permissions":"allow"}}'),
  },
  { state: "a folder where the shared config should be", write: (dir) => mkdirSync(join(dir, "config.json")) },
  {
    state: "a setup section in a shape this version does not take",
    write: (dir) =>
      writeFileSync(join(dir, "config.json"), JSON.stringify({ setup: { languages: ["en"], permissions: "ask" } })),
  },
  {
    state: 'the explicit "read only" answer',
    write: (dir) => writeFileSync(join(dir, "config.json"), JSON.stringify({ setup: { permissions: "readonly" } })),
    readOnly: true,
  },
]

const errorCodeOf = (text: string): unknown => {
  try {
    return (JSON.parse(text.trim()) as { error?: { code?: unknown } }).error?.code
  } catch {
    return undefined
  }
}

/**
 * Cases that a CLI's sync runs right after install, whatever state the shared config is in. The kit points
 * `WIRECAT_CONFIG_DIR` at a folder of its own, so the owner's config never hides the failure; the store is the one
 * the CLI's own harness gives.
 */
export const syncAfterInstallCases = (options: SyncAfterInstallOptions): SyncAfterInstallCase[] => {
  const { sync, refusedUnderReadOnly } = options
  const cli = async (argv: readonly string[], shared: (typeof SHARED_CONFIGS)[number]) => {
    const configDir = mkdtempSync(join(tmpdir(), "sync-after-install-"))
    shared.write?.(configDir)
    const ran = await options.run(argv.includes("--json") ? [...argv] : [...argv, "--json"], {
      WIRECAT_CONFIG_DIR: configDir,
    })
    return { code: ran.code, out: ran.out ?? "", err: ran.err }
  }
  return [
    ...SHARED_CONFIGS.map(
      (shared): SyncAfterInstallCase => ({
        name: `${sync.join(" ")} runs with ${shared.state}`,
        run: async () => {
          const ran = await cli(sync, shared)
          assert.notEqual(errorCodeOf(ran.err), "permission_error", `sync was refused: ${ran.err}`)
          assert.equal(ran.code, 0, `sync exited ${ran.code}: ${ran.out}${ran.err}`)
        },
      }),
    ),
    ...(refusedUnderReadOnly
      ? [
          {
            name: `${refusedUnderReadOnly.join(" ")} is still refused under the explicit "read only" answer`,
            run: async () => {
              const readOnly = SHARED_CONFIGS.find((one) => one.readOnly) as (typeof SHARED_CONFIGS)[number]
              const ran = await cli(refusedUnderReadOnly, readOnly)
              assert.equal(errorCodeOf(ran.err), "permission_error", `it was not refused: ${ran.out}${ran.err}`)
            },
          },
        ]
      : []),
  ]
}
