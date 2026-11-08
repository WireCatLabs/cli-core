import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { pasteHint } from "./prompt.js"

const python = spawnSync("python3", ["--version"]).status === 0
const prompt = fileURLToPath(new URL("./prompt.ts", import.meta.url))

const child = `
import { registerHooks } from "node:module"
registerHooks({
  resolve: (specifier, context, next) => {
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.replace(/\\.js$/, ".ts"), context)
      throw error
    }
  },
})
const { readSecret } = await import(${JSON.stringify(prompt)})
try {
  console.log("RESULT " + JSON.stringify({ answer: await readSecret("token: ") }))
} catch (error) {
  console.log("RESULT " + JSON.stringify({ code: error.code, reason: error.details?.reason, message: error.message }))
}
`

const driver = `
import json, os, pty, select, sys
keys = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out, sent = b"", 0
while True:
    ready, _, _ = select.select([fd], [], [], 20)
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    while sent < len(keys) and out.count(b"token: ") > sent:
        os.write(fd, keys[sent].encode())
        sent += 1
os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
`

const atTerminal = (keys: string[]) => {
  const run = spawnSync(
    "python3",
    ["-I", "-c", driver, JSON.stringify(keys), process.execPath, "--input-type=module", "-e", child],
    { encoding: "utf8", timeout: 30_000 },
  )
  const [screen = "", result] = run.stdout.split("RESULT ")
  return { screen, result: result ? JSON.parse(result) : undefined }
}

describe.skipIf(!python || process.platform === "win32")("readSecret at a real terminal", () => {
  it("asks again after an empty Enter, says how to paste, and takes the token typed next", () => {
    const { screen, result } = atTerminal(["\r", "acme_test_demo\r"])

    expect(result).toEqual({ answer: "acme_test_demo" })
    expect(screen).toContain(pasteHint())
    expect(screen.split("token: ")).toHaveLength(3)
    expect(screen).not.toContain("acme_test_demo")
  })

  it("fails with the reason after three empty answers", () => {
    const { screen, result } = atTerminal(["\r", "\r", "\r"])

    expect(result).toMatchObject({ code: "validation_error", reason: "input.empty" })
    expect(result.message).toContain(pasteHint())
    expect(screen.split("token: ")).toHaveLength(4)
  })

  it("is cancelled at once by Ctrl-C, with no second try", () => {
    const { screen, result } = atTerminal(["\x03"])

    expect(result).toMatchObject({ code: "cancelled" })
    expect(screen).not.toContain(pasteHint())
  })
})

describe("pasteHint", () => {
  it.each([
    ["linux", "Ctrl+Shift+V (or right-click → Paste)"],
    ["win32", "Ctrl+Shift+V (or right-click → Paste)"],
    ["darwin", "Cmd+V"],
  ] as const)("names the paste keys on %s", (platform, keys) => {
    expect(pasteHint(platform)).toBe(`Nothing arrived. To paste in a terminal, use ${keys}.`)
  })
})
