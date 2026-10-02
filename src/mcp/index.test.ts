import { describe, expect, it } from "vitest"
import { installStdioEntry, probeStdio, type StdioEntry, setupArguments } from "./index.js"

const entry: StdioEntry = {
  type: "stdio",
  command: "/usr/bin/node",
  args: ["/opt/max/dist/bin/max.js", "work", "mcp"],
  env: { MAX_CONFIG_DIR: "/tmp/work config" },
}

describe("local MCP setup", () => {
  it("uses the clients' own commands and preserves paths and environment values as arguments", () => {
    expect(setupArguments("codex", "max-work", entry)).toEqual([
      "mcp",
      "add",
      "max-work",
      "--env",
      "MAX_CONFIG_DIR=/tmp/work config",
      "--",
      "/usr/bin/node",
      "/opt/max/dist/bin/max.js",
      "work",
      "mcp",
    ])
    expect(setupArguments("claude-code", "max-work", entry)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "max-work",
      "--env",
      "MAX_CONFIG_DIR=/tmp/work config",
      "--",
      "/usr/bin/node",
      "/opt/max/dist/bin/max.js",
      "work",
      "mcp",
    ])
  })

  it("refuses an existing entry without removing it", () => {
    const calls: string[][] = []
    expect(() =>
      installStdioEntry("codex", "max-work", entry, {
        run: (_file, args) => {
          calls.push(args)
          return { status: 0, stdout: "{}", stderr: "" }
        },
      }),
    ).toThrow("already configured")
    expect(calls).toEqual([["mcp", "get", "max-work", "--json"]])
  })

  it("adds a missing entry without touching other entries", () => {
    const calls: string[][] = []
    const installed = installStdioEntry("claude-code", "tg", entry, {
      run: (_file, args) => {
        calls.push(args)
        return calls.length === 1
          ? { status: 1, stdout: 'No MCP server named "tg"', stderr: "" }
          : { status: 0, stdout: "Added", stderr: "" }
      },
    })
    expect(installed.name).toBe("tg")
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ["mcp", "get"],
      ["mcp", "add"],
    ])
  })
})

describe("local MCP doctor", () => {
  it("initializes a stdio server and lists tools without calling them", async () => {
    const program = [
      "const rl = require('node:readline').createInterface({input: process.stdin});",
      "rl.on('line', line => { const m = JSON.parse(line);",
      "if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}})+'\\n');",
      "if (m.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'max_status',annotations:{readOnlyHint:true}},{name:'max_messages_send',annotations:{readOnlyHint:false}}]}})+'\\n');",
      "if (m.method === 'tools/call') process.exit(10);",
      "});",
    ].join("")
    await expect(probeStdio({ type: "stdio", command: process.execPath, args: ["-e", program] })).resolves.toEqual({
      tools: ["max_status", "max_messages_send"],
      potentialWrites: ["max_messages_send"],
    })
  })
})
