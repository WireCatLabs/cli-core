import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/client"
// The development copy of the SDK stands for an app's own, as cli-memo builds its server with.
import { McpServer as AppMcpServer, InMemoryTransport } from "@modelcontextprotocol/server"
import * as v from "valibot"
import { freePort, mcpHttpClient } from "../src/testing/mcp-http-client.ts"

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"

/** What scripts/bundle-libraries.ts bundled answers from dist as the packages did: MCP, Liquid, both suffix lists. */
export const checkBundledLibraries = async (dist: string): Promise<void> => {
  const load = (path: string) => import(pathToFileURL(join(dist, path)).href)
  const { McpServer } = await load("bundled/mcp-server.js")
  const { registerCommands } = await load("mcp/surface.js")
  const { answered } = await load("mcp/tool.js")
  const { itemOf } = await load("cli/envelope.js")
  const { serveOverHttp } = await load("mcp/http/serve.js")
  const commands = {
    "projects status": {
      title: "Status",
      description: "where a project stands",
      writes: false,
      input: v.object({}),
      run: async () => answered(itemOf({ id: "1", status: "on track" })),
    },
  }
  const status = async (client: Client, how: string) => {
    const result = await client.callTool({ name: "chat_read", arguments: { command: "projects status" } })
    const body = result.structuredContent as { item?: { status?: string } } | undefined
    if (result.isError || body?.item?.status !== "on track")
      throw new Error(`${runtime}: the bundled MCP SDK did not answer a tool call ${how}: ${JSON.stringify(result)}`)
  }

  const own = new McpServer({ name: "chat", version: "0" })
  registerCommands(own, "chat", commands)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await own.connect(serverSide)
  const local = new Client({ name: "check", version: "0" })
  await local.connect(clientSide)
  await status(local, "in memory")
  await local.close()

  const port = await freePort()
  const base = new URL(`http://127.0.0.1:${port}`)
  const codes: string[] = []
  const listening = await serveOverHttp(
    () => {
      const server = new AppMcpServer({ name: "chat", version: "0" })
      registerCommands(server, "chat", commands)
      return server
    },
    {
      publicUrl: base,
      port,
      tokenFile: join(mkdtempSync(join(tmpdir(), "core-dist-mcp-http-")), "mcp-http.json"),
      appName: "chat",
      onCode: (code: string) => codes.push(code),
    },
  )
  try {
    for (const era of ["modern", "legacy"] as const) {
      const { client } = await mcpHttpClient(base, () => codes.at(-1) ?? "", { era })
      await status(client, `over HTTP (${era}) to a server from the app's own SDK`)
      await client.close()
    }
  } finally {
    await listening.close()
  }
  console.log(`dist: the bundled MCP SDK serves a tool call in memory and over HTTP under ${runtime}`)

  const { safeLiquid } = await load("render/liquid.js")
  const liquid = safeLiquid({ parse: 10_000, memory: 1_000_000, milliseconds: 1_000 })
  const rendered = await liquid.parseAndRender("{{ name | upcase }}, {{ items | size }}", {
    name: "ана",
    items: [1, 2],
  })
  if (rendered !== "АНА, 2") throw new Error(`${runtime}: the bundled LiquidJS rendered ${JSON.stringify(rendered)}`)
  const included = await liquid.parseAndRender("{% include 'x' %}", {}).then(
    () => "rendered",
    (error: Error) => error.message,
  )
  if (!included.includes("templates cannot read files"))
    throw new Error(`${runtime}: the bundled LiquidJS let a template include a file: ${included}`)

  const { siteOf, findMentions } = await load("domain/mentions.js")
  const { getDomain, getDomainWithoutSuffix } = await load("bundled/tldts.js")
  const sites = [siteOf("docs.google.com"), siteOf("foo.github.io"), siteOf("xn--e1afmkfd.xn--p1ai")]
  if (sites.join(" ") !== "google.com foo.github.io пример.рф")
    throw new Error(`${runtime}: the bundled psl gave ${sites.join(" ")}`)
  const urls = findMentions("see example.co.uk and cache.at(i)").filter((one: { kind: string }) => one.kind === "url")
  if (urls.length !== 1 || urls[0].domain !== "example.co.uk")
    throw new Error(`${runtime}: mentions from dist found ${JSON.stringify(urls)}`)
  if (getDomain("mail.example.co.uk") !== "example.co.uk" || getDomainWithoutSuffix("example.co.uk") !== "example")
    throw new Error(`${runtime}: the bundled tldts did not find example.co.uk`)

  const { knownRussianWord } = await load("search/russian-dictionary.js")
  if (!knownRussianWord("квартиры") || knownRussianWord("квартрыы"))
    throw new Error(`${runtime}: the gzipped Russian dictionary did not tell a word from a garbled one`)
  console.log("dist: the bundled LiquidJS, psl, tldts and the gzipped Russian dictionary work")
}
