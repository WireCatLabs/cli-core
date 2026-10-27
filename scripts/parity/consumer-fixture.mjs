import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { sandboxEnvironment } from "./evidence.ts"

const cli = process.argv[2],
  repo = process.argv[3],
  require = createRequire(`${repo}/package.json`)
const { captureStreams, memoryKeyring } = await import(require.resolve("@wirecat/cli-base"))
const { seedSearchRecipes } = await import(require.resolve("@wirecat/cli-core/testing"))
const { servicesFor, storedDeps } = await import(require.resolve("@wirecat/cli-core/services"))
const { openStore } = await import(require.resolve("@wirecat/cli-core/store"))
const { rememberAccount } = await import(require.resolve("@wirecat/cli-core/cli"))
const temp = mkdtempSync(join(tmpdir(), `parity-deep-search-${cli}-`))
for (const key of Object.keys(process.env)) {
  if (/^(MAX_|TG_|MESSAGING_|CLI_COMMON_|WIRECAT_|OPENAI_|ANTHROPIC_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, sandboxEnvironment(temp))

const { run } = await import(`${repo}/dist/program.js`)
const app = await import(`${repo}/dist/app.js`)
const identity = app.MAX_APP ?? app.TG
const provider = cli === "max" ? "max" : "telegram"
let maxSession
let networkAttempts = 0
const refuseNetwork = () => {
  networkAttempts++
  throw new Error("audit cannot connect")
}
globalThis.fetch = refuseNetwork
rememberAccount(identity, "default", "500", process.env)
if (cli === "max") {
  const { SessionStore } = await import(`${repo}/dist/session/store.js`)
  const session = new SessionStore({ keyring: memoryKeyring(), env: process.env })
  maxSession = session
  session.writeState({ ...session.readState(), viewerId: "500" })
}
const recipes = JSON.parse(readFileSync(process.argv[4], "utf8"))
const db = await openStore({ path: process.env.MESSAGING_STORE })
const account = { provider, account: "500" }
await seedSearchRecipes(db, account)
const descriptor =
  cli === "max"
    ? (await import(`${repo}/dist/messenger.js`)).maxMessenger
    : (await import(`${repo}/dist/commands/context.js`)).TELEGRAM
const service = servicesFor({ ...storedDeps(descriptor, db, account, {}), env: process.env, history: false })
const surfaceOf = (client, app) => {
  const listed = async (query) => {
    const result = await client.callTool({ name: `${app}_tools_search`, arguments: query ? { query } : {} })
    return JSON.parse(result.content.find((part) => part.type === "text")?.text ?? "null").items
  }
  return {
    commands: async () => (await listed()).map(({ command }) => command),
    run: async (command, args, options) => {
      const found = (await listed(command)).find((one) => one.command === command)
      return client.callTool(
        { name: `${app}_${found?.writes ? "write" : "read"}`, arguments: { command, arguments: args } },
        undefined,
        options,
      )
    },
  }
}
const runtimeArgs = process.versions.bun ? ["--preload"] : ["--import"]
const transport = new StdioClientTransport({
  command: process.execPath,
  cwd: repo,
  args: [
    ...runtimeArgs,
    fileURLToPath(new URL("./network-guard.mjs", import.meta.url)),
    `${repo}/dist/bin/${cli}.js`,
    "--no-record",
    ...(cli === "max" ? ["--no-serve"] : []),
    "mcp",
    "serve",
  ],
  env: sandboxEnvironment(temp),
  stderr: "pipe",
})
let mcpDiagnostics = ""
const client = new Client({ name: "synthetic-search-audit", version: "1" })
transport.stderr?.on("data", (chunk) => {
  mcpDiagnostics += chunk.toString()
})
try {
  await client.connect(transport)
  const commands = surfaceOf(client, cli)
  const callTool = async (command, args) => {
    const result = await commands.run(command, args, { timeout: 10000 })
    const first = result.content.find((part) => part.type === "text")
    return { isError: result.isError === true, body: result.structuredContent ?? JSON.parse(first?.text ?? "null") }
  }
  const results = []
  const cases = [...recipes.recipes, ...recipes.negative]
  for (const recipe of cases) {
    const streams = captureStreams()
    const code = await run(
      ["messages", "search", recipe.query, "--timezone", "UTC", "--json", "--offline", "--no-record"],
      {
        env: process.env,
        streams,
        tty: false,
        keyring: memoryKeyring(),
        ...(maxSession ? { store: () => maxSession, connection: refuseNetwork } : {}),
        adapter: () => {
          networkAttempts++
          throw Error("audit cannot connect")
        },
      },
    )
    const stdout = streams.stdout.join("\n")
    const stderr = streams.stderr.join("\n")
    if (recipe.ids) {
      assert.equal(code, 0, recipe.title + stderr)
      const a = JSON.parse(stdout)
      assert.deepEqual(a.items.map((x) => x.id).sort(), recipe.ids, recipe.title)
      assert.equal(a.query.language, "lucene-v1")
      assert.ok(a.coverage)
      const direct = await service.messages.search({
        text: recipe.query,
        timezone: "UTC",
        limit: 20,
      })
      const mcp = await callTool("messages search", {
        text: recipe.query,
        timezone: "UTC",
        limit: 20,
      })
      assert.equal(mcp.isError, false, recipe.title)
      assert.deepEqual(direct.query, a.query, `${recipe.title}: CLI/service query metadata`)
      assert.deepEqual(mcp.body.query, a.query, `${recipe.title}: CLI/MCP query metadata`)
      assert.deepEqual(direct.coverage, a.coverage, `${recipe.title}: CLI/service coverage`)
      assert.deepEqual(mcp.body.coverage, a.coverage, `${recipe.title}: CLI/MCP coverage`)
      const ordered = a.items.map((hit) => hit.locator)
      assert.deepEqual(
        direct.items.map((hit) => hit.locator),
        ordered,
        `${recipe.title}: CLI/service`,
      )
      assert.deepEqual(
        mcp.body.items.map((hit) => hit.locator),
        ordered,
        `${recipe.title}: CLI/MCP`,
      )
      results.push({
        query: recipe.query,
        mode: recipe.explicit ? "explicit" : "default",
        code,
        ids: a.items.map((x) => x.id).sort(),
        metadataKeys: Object.keys(a).sort(),
        interfaces: ["cli", "mcp", "service"],
      })
    } else {
      assert.equal(code, 2, recipe.query)
      assert.ok(stderr.includes(recipe.reason), stderr)
      await assert.rejects(
        service.messages.search({
          text: recipe.query,
          timezone: "UTC",
          limit: 20,
        }),
        (error) => error.code === recipe.code && error.details.reason === recipe.reason,
      )
      const mcp = await callTool("messages search", {
        text: recipe.query,
        timezone: "UTC",
        limit: 20,
      })
      assert.equal(mcp.isError, true)
      assert.equal(mcp.body.error.code, recipe.code)
      assert.equal(mcp.body.error.reason, recipe.reason)
      results.push({
        query: recipe.query,
        mode: recipe.explicit ? "explicit" : "default",
        code,
        reason: recipe.reason,
        interfaces: ["cli", "mcp", "service"],
      })
    }
  }
  const reads = []
  for (const argv of [
    ["chats", "list", "--limit", "2"],
    ["chats", "list", "--kind", "group"],
    ["chats", "show", "7"],
    ["messages", "list", "7", "--limit", "2"],
    ["messages", "show", "7", "101"],
    ["messages", "context", "7", "102", "--before-n", "1", "--after-n", "1"],
    ["messages", "list", "7", "--before-id", "105", "--limit", "2"],
    ["store", "check"],
  ]) {
    const streams = captureStreams()
    const code = await run([...argv, "--json", "--offline", "--no-record"], {
      env: process.env,
      streams,
      tty: false,
      keyring: memoryKeyring(),
      ...(maxSession ? { store: () => maxSession, connection: refuseNetwork } : {}),
      adapter: () => {
        networkAttempts++
        throw Error("audit cannot connect")
      },
    })
    assert.equal(code, 0, argv.join(" ") + streams.stderr.join(" "))
    reads.push({ argv, code, answer: JSON.parse(streams.stdout.join("\n")) })
  }
  const checks = []
  const invoke = async (argv, jsonl = false) => {
    const streams = captureStreams()
    const code = await run([...argv, jsonl ? "--jsonl" : "--json", "--offline", "--no-record"], {
      env: process.env,
      streams,
      tty: false,
      keyring: memoryKeyring(),
      ...(maxSession ? { store: () => maxSession, connection: refuseNetwork } : {}),
      adapter: refuseNetwork,
    })
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  for (const limit of [1, 2, 20, 100]) {
    const result = await invoke(["messages", "search", "кафе OR библиотека", "--limit", String(limit)])
    assert.equal(result.code, 0)
    const cliIds = JSON.parse(result.stdout).items.map((hit) => hit.locator)
    const direct = await service.messages.search({ text: "кафе OR библиотека", language: "lucene", limit })
    const mcp = await callTool("messages search", { text: "кафе OR библиотека", limit })
    assert.deepEqual(
      direct.items.map((hit) => hit.locator),
      cliIds,
    )
    assert.deepEqual(
      mcp.body.items.map((hit) => hit.locator),
      cliIds,
    )
    checks.push({ name: `limit ${limit}`, pass: true })
  }
  for (const value of ["0", "-1", "1.5", "NaN"]) {
    const result = await invoke(["messages", "search", "кафе", "--limit", value])
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, "")
    checks.push({ name: `invalid limit ${value}`, pass: true })
  }
  for (const text of ["", "   ", "x".repeat(8193)]) {
    const result = await invoke(["messages", "search", text])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, "")
    const reason = JSON.parse(result.stderr).error.reason
    await assert.rejects(service.messages.search({ text, limit: 20 }), (error) => error.details.reason === reason)
    const mcp = await callTool("messages search", { text })
    assert.equal(mcp.body.error.reason, reason)
    checks.push({ name: text.length > 8192 ? "oversized query" : "empty/whitespace query", pass: true })
  }
  for (const text of ["", "  ", "x".repeat(8193)]) {
    const result = await invoke(["conversations", "search", text])
    assert.equal(result.code, 2)
    const mcp = await callTool("conversations search", { query: text })
    assert.equal(mcp.isError, true)
    await assert.rejects(service.embeddings.search(text, { limit: 20 }), (error) => error.code === "validation_error")
    checks.push({ name: "topic query size/empty bounds", pass: true })
  }
  await assert.rejects(
    service.messages.search({ text: "кафе", limit: 20, signal: AbortSignal.abort() }),
    (error) => error.details.reason === "query.aborted",
  )
  checks.push({ name: "pre-aborted query", pass: true })
  const anchor = recipes.messages[0]
  const locator = `msg:${provider}/500/${anchor.chatId}/${anchor.id}`
  const foreign = `msg:${provider}/501/${anchor.chatId}/${anchor.id}`
  for (const mode of ["show", "context"]) {
    const refused = await invoke(["messages", mode, foreign])
    assert.equal(refused.code, 2)
    assert.ok(refused.stderr.includes("another account"))
    const accepted = await invoke(["messages", mode, locator])
    assert.equal(accepted.code, 0)
    const mcp = await callTool("messages context", { chat: foreign, offline: true })
    assert.equal(mcp.body.error.code, "validation_error")
    checks.push({ name: `${mode} locator account isolation`, pass: true })
  }
  assert.equal((await invoke(["conversations", "build", "--chat", "7"])).code, 0)
  const shadow = { provider, account: "501" }
  await db.chats.saveChats(shadow, [
    {
      ...recipes.chats[0],
      id: "7",
      title: "Synthetic shadow",
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: 2,
    },
  ])
  await db.messages.saveMessages(
    shadow,
    "7",
    [
      {
        ...recipes.messages[0],
        id: "100",
        chatId: "7",
        senderId: "900",
        senderName: "Synthetic C",
        text: "scopeprobetoken",
        timestamp: "2026-01-01T10:00:00.000Z",
        outgoing: false,
        editedAt: null,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
      {
        ...recipes.messages[0],
        id: "101",
        chatId: "7",
        senderId: "901",
        senderName: "Synthetic D",
        text: "qualified followup",
        timestamp: "2026-01-01T10:01:00.000Z",
        outgoing: false,
        editedAt: null,
        attachments: [],
        replyTo: null,
        replyToId: "100",
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "synthetic" },
  )
  const shadowService = servicesFor({ ...storedDeps(descriptor, db, shadow, {}), env: process.env, history: false })
  await shadowService.conversations.build("7")
  for (const source of [undefined, "all"]) {
    const found = await invoke(["messages", "search", "scopeprobetoken", ...(source ? ["--source", source] : [])])
    assert.equal(found.code, 0)
    const expected = source ? [`msg:${provider}/501/7/100`] : []
    assert.deepEqual(
      JSON.parse(found.stdout).items.map((hit) => hit.locator),
      expected,
    )
    assert.deepEqual(
      (await callTool("messages search", { text: "scopeprobetoken", ...(source ? { source } : {}) })).body.items.map(
        (hit) => hit.locator,
      ),
      expected,
    )
    assert.deepEqual(
      (await service.messages.search({ text: "scopeprobetoken", limit: 20, ...(source ? { source } : {}) })).items.map(
        (hit) => hit.locator,
      ),
      expected,
    )
  }
  const filtered = await invoke([
    "conversations",
    "search",
    "scopeprobetoken",
    "--source",
    "all",
    "--filter",
    "from:901",
  ])
  assert.equal(filtered.code, 0)
  const eligible = await callTool("conversations search", {
    query: "scopeprobetoken",
    source: "all",
    filter: "from:901",
  })
  const eligibleService = await service.embeddings.search("scopeprobetoken", {
    limit: 20,
    source: "all",
    filter: "from:901",
  })
  const eligibleIds = JSON.parse(filtered.stdout).items.map((hit) => hit.locator)
  assert.deepEqual(eligibleIds, [`msg:${provider}/501/7/100`])
  assert.deepEqual(
    eligible.body.items.map((hit) => hit.locator),
    eligibleIds,
  )
  assert.deepEqual(
    eligibleService.hits.map((hit) => hit.locator),
    eligibleIds,
  )
  checks.push({ name: "explicit source and any-message hybrid eligibility", pass: true })
  const topic = await invoke(["conversations", "search", "кафе", "--chat", "7"])
  assert.equal(topic.code, 0)
  const topicBody = JSON.parse(topic.stdout)
  const topicMcp = await callTool("conversations search", { query: "кафе", chat: "7" })
  const topicService = await service.embeddings.search("кафе", { chat: "7", limit: 20 })
  const firstIds = (hits) => hits.map((hit) => hit.summary.firstMessageId)
  assert.deepEqual(firstIds(topicMcp.body.items), firstIds(topicBody.items ?? topicBody.hits))
  assert.deepEqual(firstIds(topicService.hits), firstIds(topicBody.items ?? topicBody.hits))
  assert.equal(topicBody.meaning, "unavailable")
  const prompt = (await client.getPrompt({ name: "link-conversations" })).messages[0]
  assert.ok(prompt.content.text.includes(`${cli}_read`))
  assert.ok(prompt.content.text.includes("conversations batches status"))
  checks.push({ name: "words-only topic fallback and linking prompt", pass: true })
  const statsQuery = 'from:("Alice Synthetic" OR "Bob Synthetic")'
  const statsCli = await invoke(["stats", "messages", "show", statsQuery, "--by", "chat"])
  const statsMcp = await callTool("stats messages show", { text: statsQuery, by: "chat" })
  assert.equal(statsCli.code, 0)
  assert.equal(statsMcp.isError, false)
  assert.equal(typeof statsMcp.body.total, "number")
  assert.equal(statsMcp.body.total, JSON.parse(statsCli.stdout).total)
  assert.equal((await service.messages.stats({ text: statsQuery, by: "chat", limit: 20 })).total, statsMcp.body.total)
  const packetCli = await invoke(["messages", "context", locator, "--thread"])
  const packetMcp = await callTool("messages context", { chat: locator, thread: true, before_n: 5, after_n: 5 })
  assert.equal(packetCli.code, 0)
  assert.deepEqual(
    packetMcp.body.items.map((hit) => hit.id),
    JSON.parse(packetCli.stdout).items.map((hit) => hit.id),
  )
  checks.push({ name: "statistics and graph context interfaces", pass: true })
  await db.messages.saveMessages(
    account,
    "20",
    [
      {
        ...recipes.messages[0],
        id: "9900",
        chatId: "20",
        text: "synthetic attachment",
        outgoing: false,
        editedAt: null,
        attachments: [{ kind: "file", name: "audit.txt", mime: "text/plain", size: 40 }],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "synthetic" },
  )
  const plain = join(temp, "audit.txt")
  writeFileSync(plain, "syntheticfiletoken original text")
  assert.equal(
    await db.attachments.keepDownloads(account, "20", "9900", [{ kind: "file", name: "audit.txt", path: plain }]),
    1,
  )
  const extraction = await invoke(["attachments", "extract", "--chat", "20", "--limit", "1"])
  assert.equal(extraction.code, 0, extraction.stderr)
  assert.equal(JSON.parse(extraction.stdout).extracted, 1)
  const written = await callTool("attachments text set", {
    chat: "20",
    message: "9900",
    text: "agentfiletoken replacement",
    attachment: 1,
  })
  assert.equal(written.isError, false)
  const fromFile = await invoke(["messages", "search", "content:agentfiletoken"])
  assert.deepEqual(
    JSON.parse(fromFile.stdout).items.map((hit) => hit.id),
    ["9900"],
  )
  assert.deepEqual(
    (await service.messages.search({ text: "content:agentfiletoken", limit: 20 })).items.map((hit) => hit.id),
    ["9900"],
  )
  assert.deepEqual(
    (await callTool("messages search", { text: "content:agentfiletoken" })).body.items.map((hit) => hit.id),
    ["9900"],
  )
  writeFileSync(plain, "clifiletoken writeback")
  assert.equal(
    (await invoke(["attachments", "text", "set", "20", "9900", "--attachment", "1", "--text-file", plain])).code,
    0,
  )
  assert.deepEqual(
    (await callTool("messages search", { text: "content:clifiletoken" })).body.items.map((hit) => hit.id),
    ["9900"],
  )
  assert.equal((await invoke(["attachments", "extract", "--chat", "20", "--limit", "1"])).code, 0)
  assert.deepEqual(
    (await callTool("messages search", { text: "content:clifiletoken" })).body.items.map((hit) => hit.id),
    ["9900"],
  )
  checks.push({ name: "plain extraction and CLI/MCP agent write-back preserve origin", pass: true })
  assert.equal((await invoke(["tags", "add", "audit-tag", "--chat", "7"])).code, 0)
  const tagged = await invoke(["messages", "search", "tag:audit-tag", "--source", "all"])
  const taggedItems = JSON.parse(tagged.stdout).items
  assert.ok(taggedItems.length > 0)
  assert.ok(taggedItems.every((hit) => hit.locator.startsWith(`msg:${provider}/500/`)))
  assert.equal((await invoke(["searches", "create", "audit-recipe", "кафе"])).code, 0)
  const saved = await invoke(["messages", "search", "--saved", "audit-recipe"])
  const savedMcp = await callTool("messages search", { saved: "audit-recipe" })
  assert.deepEqual(
    savedMcp.body.items.map((hit) => hit.locator),
    JSON.parse(saved.stdout).items.map((hit) => hit.locator),
  )
  assert.ok((await service.searches.list()).some((row) => row.name === "audit-recipe"))
  checks.push({ name: "account-isolated tags and saved search interfaces", pass: true })
  const configPath = join(temp, `${cli}-config`, "config.json")
  mkdirSync(join(temp, `${cli}-config`), { recursive: true })
  writeFileSync(
    configPath,
    JSON.stringify({
      profiles: {
        auditreadonly: {
          permissions: {
            messages: "readonly",
            conversations: "readonly",
            attachments: "readonly",
            tags: "readonly",
            searches: "readonly",
          },
        },
        auditdenied: { permissions: { messages: "deny" } },
        auditasked: { permissions: { "conversations.links": "ask" } },
      },
    }),
  )
  for (const profile of ["auditreadonly", "auditdenied", "auditasked"]) {
    rememberAccount(identity, profile, "500", process.env)
    if (cli === "max") {
      const { SessionStore } = await import(`${repo}/dist/session/store.js`)
      const scope = new SessionStore({ profile, keyring: memoryKeyring(), env: process.env })
      scope.writeState({ ...scope.readState(), viewerId: "500" })
    }
    const restrictedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...runtimeArgs,
        fileURLToPath(new URL("./network-guard.mjs", import.meta.url)),
        `${repo}/dist/bin/${cli}.js`,
        profile,
        "--no-record",
        ...(cli === "max" ? ["--no-serve"] : []),
        "mcp",
        "serve",
      ],
      env: sandboxEnvironment(temp),
      stderr: "pipe",
      cwd: repo,
    })
    const restricted = new Client({ name: "synthetic-search-scope-audit", version: "1" })
    restrictedTransport.stderr?.on("data", (chunk) => {
      mcpDiagnostics += chunk.toString()
    })
    try {
      await restricted.connect(restrictedTransport)
      const restrictedCommands = surfaceOf(restricted, cli)
      const names = await restrictedCommands.commands()
      if (profile === "auditreadonly") {
        assert.ok(names.includes("messages search"))
        for (const command of [
          "conversations build",
          "conversations links add",
          "attachments text set",
          "tags add",
          "searches create",
        ])
          assert.ok(!names.includes(command))
      } else if (profile === "auditdenied") {
        for (const command of [
          "messages search",
          "messages context",
          "conversations search",
          "conversations batches next",
          "attachments list",
        ])
          assert.ok(!names.includes(command))
      } else {
        assert.ok(names.includes("conversations build"))
        const result = await restrictedCommands.run("conversations build", { chat: "7" })
        assert.notEqual(result.isError, true)
        assert.equal(result.structuredContent.chat, "7")
      }
      checks.push({ name: `${profile} tool visibility/refusal`, pass: true })
    } finally {
      await restricted.close()
    }
  }
  const jsonl = await invoke(["messages", "search", "кафе"], true)
  assert.equal(jsonl.code, 0)
  for (const row of jsonl.stdout.trim().split("\n").filter(Boolean)) assert.ok(JSON.parse(row).id)
  checks.push({ name: "JSONL contains only message rows", pass: true })
  await client.close()
  await db.close()
  assert.ok(!mcpDiagnostics.includes("AUDIT_NETWORK_ATTEMPTS"), mcpDiagnostics)
  assert.equal(networkAttempts, 0)
  console.log(
    JSON.stringify(
      { cli, provider, runtime: process.versions.bun ? "bun" : "node", results, reads, checks, networkAttempts, temp },
      null,
      2,
    ),
  )
} catch (error) {
  process.stderr.write(`scratch=${temp}\n${mcpDiagnostics}`)
  await client.close().catch(() => {})
  await db.close().catch(() => {})
  throw error
}
