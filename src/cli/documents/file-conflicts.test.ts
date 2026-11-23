import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { type FileTarget, fileSyncState, fileVersions, type Mirror } from "../../documents.js"
import { provide } from "../context.js"
import type { Body } from "../envelope.js"
import { fileConflictsCommand } from "./file-conflicts.js"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "file-conflicts-root-"))
  const stateDir = mkdtempSync(join(tmpdir(), "file-conflicts-state-"))
  const mirror: Mirror = { id: "m1", path: root, folder: "/Notes" }
  const port = fileSyncState(stateDir, mirror, "alpha")
  const versions = fileVersions(join(stateDir, "versions"))
  const keep = async (text: string) => {
    const file = join(stateDir, sha(text))
    writeFileSync(file, text)
    return versions.keep(file)
  }
  const [base, local, remote] = await Promise.all(["a\nb\n", "a\nmine\n", "a\ntheirs\n"].map(keep))
  writeFileSync(join(root, "plan.md"), "a\nmine\n")
  const state = port.read()
  const remoteFile = { path: "plan.md", id: "r1", size: 9, sha256: remote, modifiedAt: "2026-11-18T10:00:00.000Z" }
  state.conflicts = {
    "plan.md": {
      reason: "changed on both sides in the same lines",
      at: "2026-11-18T12:00:00.000Z",
      base,
      local,
      remote,
      remoteFile,
      kept: true,
    },
  }
  port.save(state)
  const target = { identity: async () => "alpha" } as unknown as FileTarget
  const bodies: Body[] = []
  const program = new Command("host").option("--json").exitOverride()
  provide(program, { streams: captureStreams(), env: {}, tty: false })
  program.addCommand(
    new Command("mirrors").addCommand(
      fileConflictsCommand({
        identity: {
          command: "ydisk",
          appName: "ydisk-cli",
          envPrefix: "YDISK",
          description: "ydisk",
          version: "1.0.0",
        },
        remote: "disk",
        output: (_command, body) => bodies.push(body),
        mirrors: () => [mirror],
        pathOf: (_mirror, input) => input,
        stateOf: () => port,
        versionsOf: () => versions,
        connect: async () => ({
          target,
          principal: "alpha",
          guard: (_attempt, act) => act(),
          operationId: () => "op1",
          lock: async () => ({ assertHeld: () => {}, release: () => {} }),
        }),
      }),
    ),
  )
  const run = async (...args: string[]) => {
    await program.parseAsync(["mirrors", "conflicts", ...args], { from: "user" })
    return bodies.at(-1) as Body & { item?: Record<string, unknown>; items?: Record<string, unknown>[] }
  }
  return { root, port, run }
}

describe("mirrors conflicts", () => {
  it("lists a conflict, shows its versions and merge, and resolves it by keeping the disk's side", async () => {
    const { root, port, run } = await setup()
    expect((await run("list")).items).toEqual([expect.objectContaining({ id: "m1", path: "plan.md", kept: true })])
    const shown = (await run("show", "m1", "plan.md")).item
    expect(shown).toMatchObject({ local_changed: false, remote: { sha256: sha("a\ntheirs\n"), text: "a\ntheirs\n" } })
    expect(shown?.merged).toContain(">>>>>>> disk")
    expect((await run("resolve", "m1", "plan.md", "--keep", "disk")).item).toMatchObject({ resolution: "disk" })
    expect(readFileSync(join(root, "plan.md"), "utf8")).toBe("a\ntheirs\n")
    expect(port.read().conflicts).toBeUndefined()
  })

  it("refuses a final file from the app's own folders, which hold sign-ins and state", async () => {
    const { run } = await setup()
    await expect(
      run("resolve", "m1", "plan.md", "--file", join(homedir(), ".config", "ydisk-cli", "credentials.json")),
    ).rejects.toMatchObject({ code: "validation_error", details: { param: "--file" } })
  })

  it("asks for exactly one of --keep and --file", async () => {
    const { run } = await setup()
    await expect(run("resolve", "m1", "plan.md")).rejects.toMatchObject({ code: "validation_error" })
  })
})
