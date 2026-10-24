import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { type MirrorWatchEvent, watchMirrors } from "./mirror-watch.js"
import { fileMirrorState, type Mirror } from "./mirrors.js"
import { scanLocal } from "./push.js"

type Snapshot = { kind: "doc" }
const kindOf = (path: string) => (path.endsWith(".md") ? "doc" : undefined)

const mirrorAt = (id: string, files: Record<string, string>): Mirror => {
  const path = mkdtempSync("/var/tmp/mirror-watch-")
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text)
  return { id, path, folder: `folder-${id}` }
}

/**
 * A watch on a clock that jumps to each wake-up. `at(ms, act)` runs `act` once the clock passes `ms`; the watch stops
 * after `cycles` cycles. The sync records the local files as pushed, as a real sync leaves them.
 */
const harness = (mirrors: Mirror[], cycles: number) => {
  let clock = 0
  const stop = new AbortController()
  const stateDir = mkdtempSync("/var/tmp/mirror-watch-state-")
  const stateOf = (mirror: Mirror) => fileMirrorState<Snapshot>(stateDir, mirror, "alpha", ["doc"])
  const saved = new Map<string, () => void>()
  const scripted: { ms: number; act: () => void | Promise<void> }[] = []
  const events: MirrorWatchEvent<string[]>[] = []
  let failNext = false
  const sync = async (chosen: Mirror[]) => {
    if (failNext) {
      failNext = false
      throw new CliError("provider_unavailable", "profile lock is held")
    }
    for (const mirror of chosen) {
      const port = stateOf(mirror)
      const state = port.read()
      for (const file of (await scanLocal(mirror.path, kindOf)).files)
        state.entries[file.path] = {
          id: file.path.replace(/[^A-Za-z0-9_-]/g, "-"),
          url: "",
          kind: "doc",
          hash: file.hash,
          snapshot: { kind: "doc" },
          pushedAt: "",
        }
      port.save(state)
    }
    return chosen.map((mirror) => mirror.id)
  }
  let remote: string[] | "all" = []
  const options = {
    mirrors,
    signal: stop.signal,
    kindOf,
    stateOf,
    remoteChanges: async () => {
      const found = remote
      remote = []
      return found
    },
    pollMs: 60_000,
    quietMs: 2_000,
    checkMs: 300_000,
    fullMs: 1_800_000,
    now: () => clock,
    watchFolder: (root: string, changed: () => void) => {
      saved.set(root, changed)
      return () => saved.delete(root)
    },
    // Wakes at a scripted step that comes first, as a file event would.
    sleep: async (ms: number) => {
      const next = Math.min(...scripted.map((one) => one.ms))
      clock = Math.min(clock + ms, Math.max(clock, next))
      for (const step of scripted.filter((one) => one.ms <= clock)) {
        scripted.splice(scripted.indexOf(step), 1)
        await step.act()
      }
    },
  }
  return {
    at: (ms: number, act: () => void | Promise<void>) => scripted.push({ ms, act }),
    save: (mirror: Mirror, name: string, text: string) => {
      writeFileSync(join(mirror.path, name), text)
      saved.get(mirror.path)?.()
    },
    remoteSays: (ids: string[] | "all") => {
      remote = ids
    },
    failNextSync: () => {
      failNext = true
    },
    clock: () => clock,
    watching: () => saved.size,
    run: async () => {
      for await (const event of watchMirrors(sync, options)) {
        events.push(event)
        if (events.length >= cycles) stop.abort()
      }
      return events.map((event) => ({
        triggers: event.triggers,
        mirrors: event.mirrors,
        ...("error" in event ? { error: event.error.code } : {}),
      }))
    },
  }
}

describe("watchMirrors", () => {
  it("syncs every mirror at start, then only the mirror whose files were saved and differ", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const b = mirrorAt("b", { "two.md": "two" })
    const watch = harness([a, b], 2)
    // The same content written again, as a pull writes it: no cycle.
    watch.at(1_000, () => watch.save(a, "one.md", "one"))
    watch.at(10_000, () => watch.save(b, "two.md", "two, edited"))
    expect(await watch.run()).toEqual([
      { triggers: ["start"], mirrors: ["a", "b"] },
      { triggers: ["local"], mirrors: ["b"] },
    ])
    expect(watch.watching()).toBe(0)
  })

  it("waits for the saves to settle before syncing", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const watch = harness([a], 2)
    watch.at(1_000, () => watch.save(a, "one.md", "o"))
    watch.at(2_500, () => watch.save(a, "one.md", "on, typing"))
    await watch.run()
    expect(watch.clock()).toBe(4_500)
  })

  it("syncs the mirrors the remote names at the next poll, and all of them when it cannot tell", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const b = mirrorAt("b", { "two.md": "two" })
    const watch = harness([a, b], 3)
    watch.at(30_000, () => watch.remoteSays(["b", "gone"]))
    watch.at(90_000, () => watch.remoteSays("all"))
    expect(await watch.run()).toEqual([
      { triggers: ["start"], mirrors: ["a", "b"] },
      { triggers: ["remote"], mirrors: ["b"] },
      { triggers: ["remote"], mirrors: ["a", "b"] },
    ])
  })

  it("reports a failed cycle and tries its mirrors again at the next poll", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const watch = harness([a], 3)
    watch.at(1_000, () => {
      watch.failNextSync()
      watch.save(a, "one.md", "edited")
    })
    expect(await watch.run()).toEqual([
      { triggers: ["start"], mirrors: ["a"] },
      { triggers: ["local"], mirrors: ["a"], error: "provider_unavailable" },
      { triggers: ["remote"], mirrors: ["a"] },
    ])
    expect(watch.clock()).toBe(60_000)
  })

  it("finds a change no file event reported at the periodic check", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const watch = harness([a], 2)
    watch.at(1_000, () => writeFileSync(join(a.path, "one.md"), "edited without an event"))
    expect(await watch.run()).toEqual([
      { triggers: ["start"], mirrors: ["a"] },
      { triggers: ["check"], mirrors: ["a"] },
    ])
    expect(watch.clock()).toBe(300_000)
  })

  it("syncs every mirror at the full run even when nothing was reported", async () => {
    const watch = harness([mirrorAt("a", { "one.md": "one" })], 2)
    expect(await watch.run()).toEqual([
      { triggers: ["start"], mirrors: ["a"] },
      { triggers: ["full"], mirrors: ["a"] },
    ])
    expect(watch.clock()).toBe(1_800_000)
  })

  it("hears a saved file through the real file watcher", async () => {
    const a = mirrorAt("a", { "one.md": "one" })
    const stop = new AbortController()
    const cycles: string[][] = []
    const watch = watchMirrors(async (chosen) => chosen.map((mirror) => mirror.id), {
      mirrors: [a],
      signal: stop.signal,
      kindOf,
      stateOf: (mirror) => fileMirrorState(mkdtempSync("/var/tmp/mirror-watch-state-"), mirror, "alpha", ["doc"]),
      quietMs: 50,
    })
    setTimeout(() => writeFileSync(join(a.path, "one.md"), "edited"), 200)
    const guard = setTimeout(() => stop.abort(), 10_000)
    for await (const event of watch) {
      cycles.push(event.triggers)
      if (cycles.length === 2) stop.abort()
    }
    clearTimeout(guard)
    expect(cycles).toEqual([["start"], ["local"]])
  })
})
