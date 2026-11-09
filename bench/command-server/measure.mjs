// N reads through one `commands --serve`, one at a time and all at once, against a process each.
// Run from the repository root: node bench/command-server/measure.mjs [n=7] [rounds=5] [argv...]
// It builds the test CLI (src/testing/command-server-cli.ts) and uses a throwaway store and HOME.
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { build } from "esbuild"

const [nText = "7", roundsText = "5", ...given] = process.argv.slice(2)
const n = Number(nText)
const rounds = Number(roundsText)
const argv = given.length > 0 ? given : ["work", "searches", "list", "--json"]

const root = mkdtempSync(join(tmpdir(), "command-server-bench-"))
await build({
  entryPoints: ["src/testing/command-server-cli.ts"],
  outdir: join(root, "cli"),
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  logLevel: "error",
  plugins: [
    {
      name: "packages-in-place",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, ({ path }) =>
          /^(node|bun):/.test(path) ? { external: true } : { path: import.meta.resolve(path), external: true },
        )
      },
    },
  ],
})
const cli = join(root, "cli", "command-server-cli.js")
const env = {
  ...process.env,
  HOME: join(root, "home"),
  MESSAGING_STORE: join(root, "store.db"),
  CHAT_CONFIG_DIR: join(root, "config"),
  CHAT_STATE_DIR: join(root, "state"),
  CHAT_CACHE_DIR: join(root, "cache"),
  CHAT_PROFILE: "",
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
  WIRECAT_CALLER: "desktop",
}
for (let at = 0; at < 30; at++)
  execFileSync(process.execPath, [cli, "work", "searches", "create", `saved-${at}`, `word${at} other`], { env })

const spawned = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.resume()
    child.stderr.resume()
    child.on("close", resolve)
  })

const server = async () => {
  const child = spawn(process.execPath, [cli, "commands", "--serve"], { env, stdio: ["pipe", "pipe", "inherit"] })
  const waiting = new Map()
  const ready = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const answer = JSON.parse(line)
      if (answer.ready) return resolve(answer)
      if (answer.code !== 0) process.stderr.write(`failed: ${answer.stderr}\n`)
      waiting.get(answer.id)?.(answer)
      waiting.delete(answer.id)
    })
  })
  console.log(JSON.stringify(await ready))
  let id = 0
  const ask = () =>
    new Promise((resolve) => {
      id += 1
      waiting.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ id, argv })}\n`)
    })
  return { ask, stop: () => child.stdin.end() }
}

const time = async (label, body) => {
  const took = []
  for (let round = 0; round < rounds; round++) {
    const started = performance.now()
    await body()
    took.push(performance.now() - started)
  }
  took.sort((a, b) => a - b)
  console.log(`${label}: median ${took[Math.floor(took.length / 2)].toFixed(0)} ms over ${rounds} rounds`)
}

const one = await server()
// The first request loads the program's modules, as a page's first call after the server starts.
await one.ask()
await time(`${n} reads, one server, one at a time`, async () => {
  for (let at = 0; at < n; at++) await one.ask()
})
await time(`${n} reads, one server, all at once`, () => Promise.all(Array.from({ length: n }, one.ask)))
one.stop()
await time(`${n} reads, a process each, all at once`, () => Promise.all(Array.from({ length: n }, spawned)))
await time(`${n} reads, a process each, one at a time`, async () => {
  for (let at = 0; at < n; at++) await spawned()
})
