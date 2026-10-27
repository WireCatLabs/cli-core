import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A stand-in for `<tool> <profile> mcp`: answers the handshake, lists one tool and echoes each call with the profile
 * it was started for. It writes `start <words>` and `end <words>` to `log`, the words it was started with.
 */
export const fakeProfileServer = (): { script: string; log: string } => {
  const dir = mkdtempSync(join(tmpdir(), "fake-mcp-"))
  const script = join(dir, "fake.cjs")
  const log = join(dir, "log")
  writeFileSync(script, SCRIPT)
  writeFileSync(log, "")
  return { script, log }
}

const SCRIPT = String.raw`
const fs = require("node:fs")
const words = process.argv.slice(2).join(" ")
const log = __dirname + "/log"
fs.appendFileSync(log, "start " + words + "\n")
const profile = process.argv[2]
let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\n")) !== -1) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (message.method === "initialize")
      send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "chat", version: "1" } } })
    if (message.method === "tools/list")
      send({ id: message.id, result: { tools: [{ name: "chat_read", inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] } })
    if (message.method === "tools/call")
      send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ profile, ...message.params }) }] } })
  }
})
process.stdin.on("end", () => {
  fs.appendFileSync(log, "end " + words + "\n")
  process.exit(0)
})
`
