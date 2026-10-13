import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const sandbox = mkdtempSync(join(tmpdir(), "agent-process-"))
const fixture = fileURLToPath(new URL("./fixtures/agent-cli.mjs", import.meta.url))
const check = async (args: string[], expected: number, signal?: NodeJS.Signals, pipe = false) => {
  const child = spawn(process.execPath, [fixture, "probe", "--json", ...args], {
    env: {
      ...process.env,
      FIXTURE_CONFIG_DIR: join(sandbox, "config"),
      FIXTURE_STATE_DIR: join(sandbox, "state"),
      FIXTURE_CACHE_DIR: join(sandbox, "cache"),
      MESSAGING_STORE: join(sandbox, "store.db"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk
  })
  let ready = false
  child.stdout.on("data", () => {
    if (ready) return
    ready = true
    if (signal) child.kill(signal)
    if (pipe) child.stdout.destroy()
  })
  let timer: NodeJS.Timeout | undefined
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(
          new Error(
            `synthetic command failed to exit within 5s: ${args.join(" ")} ${signal ?? ""}; diagnostics=${diagnostics}`,
          ),
        )
      }, 5000)
      child.once("error", reject)
      child.once("exit", resolve)
    })
    assert.equal(code, expected, diagnostics)
    if (pipe) assert.equal(diagnostics, "")
    else {
      const { error } = JSON.parse(diagnostics.trim())
      assert.ok(error.code && error.reason, diagnostics)
      assert.equal(error.stack, undefined)
    }
  } finally {
    if (timer) clearTimeout(timer)
    child.stdin.destroy()
  }
}

await check(["--mode", "input", "--timeout", "50ms"], 9)
if (process.platform !== "win32") {
  await check([], 130, "SIGINT")
  await check([], 143, "SIGTERM")
  await check(["--mode", "pipe", "--max-output-bytes", "0"], 0, undefined, true)
}
process.stdout.write("agent process checks: ok (synthetic input deadline, signals and closed pipe)\n")
