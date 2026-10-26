/**
 * The built package opens the store through bundled Drizzle, never through `node_modules`, where
 * `drizzle-orm` is only a development dependency. Run after `pnpm build`, under Node and under Bun.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCliEntry, checkStartEntry } from "./check-cli-entry.ts"
import { checkFileLeases } from "./check-file-leases.ts"
import { checkRecordingPartials } from "./check-recording-partials.ts"
import { checkRecordingPublication } from "./check-recording-publication.ts"

const root = join(import.meta.dirname, "../dist")
checkCliEntry(root)
checkStartEntry(root)
await checkFileLeases(root)
await checkRecordingPartials(root)
await checkRecordingPublication(root)
const dist = join(root, "store/sqlite")
const leaks = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".js"))
  .filter((name) => /\b(from|import)\s*\(?\s*"drizzle-orm/.test(readFileSync(join(root, name), "utf8")))
if (leaks.length > 0) throw new Error(`dist still imports drizzle-orm: ${leaks.join(", ")}`)

const { openSqlite } = await import(join(dist, "open.js"))
const { migrate } = await import(join(dist, "../migrations.js"))
const { accounts } = await import(join(dist, "schema.js"))
const store = await openSqlite(":memory:")
migrate(store.database)
store.database
  .prepare("INSERT INTO accounts (provider, external_id, created_at, updated_at) VALUES ('telegram', '1', 0, 0)")
  .run()
const rows = await store.orm.select().from(accounts)
store.database.close()
if (rows.length !== 1) throw new Error(`bundled Drizzle read ${rows.length} rows, not 1`)

const { openStore } = await import(join(root, "store/index.js"))
const messages = await openStore({ path: join(mkdtempSync(join(tmpdir(), "cli-messaging-dist-")), "messages.db") })
const key = { provider: "telegram", account: "1" }
const message = {
  id: "3",
  chatId: "-1002",
  senderId: "7",
  senderName: null,
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "через openStore",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
await messages.messages.saveMessages(key, "-1002", [message], { via: "check" })
const read = await messages.messages.messages(key, "-1002", { limit: 5 })
const { readEvidencePacket } = await import(join(root, "services/index.js"))
const storedEvidence = await readEvidencePacket(messages, key, { chat: "-1002", limit: 5 })
if (storedEvidence.items[0]?.locator !== "msg:telegram/1/-1002/3" || storedEvidence.nextBeforeId !== null)
  throw new Error("./services from dist did not read a stored evidence packet")
const { searchStore } = await import(join(root, "services/index.js"))
const strictSearch = await searchStore(messages, key, { text: "через", limit: 5 })
if (strictSearch.items[0]?.id !== "3" || strictSearch.query?.language !== "lucene-v1")
  throw new Error("strict Lucene search failed from dist")
await messages.close()
if (read.items[0]?.text !== message.text) throw new Error("openStore from dist did not give the saved message back")
console.log(`dist: Drizzle bundled and working under ${"Bun" in globalThis ? "Bun" : "Node"}`)

const { createStemmer } = await import(join(root, "search/stem.js"))
const stems = createStemmer().stemTokens("Квартиру canciones")
if (stems.join(" ") !== "квартир cancion") throw new Error(`the vendored Snowball stemmers gave ${stems} from dist`)
console.log("dist: the vendored Snowball stemmers load and stem")

const { prepareEvidencePacket } = await import(join(root, "services/index.js"))
const evidence = prepareEvidencePacket({ kind: "chats", source: { ...key, chat: message.chatId }, page: read })
if (evidence.items[0]?.text !== message.text || evidence.items[0]?.locator !== "msg:telegram/1/-1002/3")
  throw new Error("./services from dist did not package the stored message with its source")
console.log("dist: ./services prepares an evidence packet from stored messages")

const { contractCases, fakeAdapter } = await import(join(root, "kit/index.js"))
for (const one of contractCases({ connect: fakeAdapter, orderBy: "time" })) await one.run()
console.log("dist: ./testing exports the fake adapter, and it passes the contract cases")

const tiny = {
  id: "tiny",
  dims: 4,
  maxTokens: 64,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
}

// The MCP server's model runs in a child process started from dist/embeddings/child.js.
const { openProcess } = await import(join(root, "embeddings/process.js"))
const apart = await openProcess(tiny, join(root, "../src/embeddings/fixtures"), { threads: 1 })
const [fish] = await apart.embed(["fish"], "query")
await apart.close()
if (Array.from(fish as Float32Array).join(" ") !== "0 0 1 0") {
  throw new Error("the embedding process did not give the tiny model's vector back")
}
const late = await apart.embed(["fish"], "query").then(
  () => "answered",
  (error: Error) => error.message,
)
if (!late.startsWith("the embedding process stopped")) throw new Error(`a closed embedding process ${late}`)
console.log("dist: the embedding process answers, and refuses once closed")

const speech = await import("@wirecat/cli-core/speech")
const speechCache = join(mkdtempSync(join(tmpdir(), "speech-export-dist-")), "common")
const speechDirectory = speech.modelsDirectory({ WIRECAT_STATE_DIR: speechCache })
if (speechDirectory !== join(speechCache, "models", "audio"))
  throw new Error("./speech ignores the common cache override")
if (
  speech.orderedModels(["gigaam-v3"])[0]?.id !== "gigaam-v3" ||
  speech.isInstalled(speech.speechModel("gigaam-v3"), speechDirectory)
)
  throw new Error("./speech lost consumer model ordering or claims absent files are installed")
console.log("dist: ./speech reuses the pinned catalogue and shared model directory")

const { chartRenderer, chartPng, CHART_SIZE } = await import("@wirecat/cli-core/charts")
const chart = {
  version: 1 as const,
  kind: "bar" as const,
  title: "Сообщения клуба",
  x: { type: "day" as const, values: ["2026-10-01", "2026-10-02", "2026-10-03"] },
  series: [{ name: "Messages", values: [4, null, 2] }],
  unit: "messages" as const,
  timezone: "UTC",
  partial: true,
  reasons: ["store-incomplete" as const],
}
const png = await chartPng(await (await chartRenderer()).render(chart, CHART_SIZE))
const pngBytes = Buffer.from(png.bytes)
if (
  png.mimeType !== "image/png" ||
  pngBytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
  pngBytes.readUInt32BE(16) !== 800 ||
  pngBytes.readUInt32BE(20) !== 400
)
  throw new Error("./charts from dist did not encode an 800×400 PNG")
if (!readFileSync(join(root, "charts/fonts/OFL.txt"), "utf8").includes("SIL OPEN FONT LICENSE"))
  throw new Error("the chart font license is absent from dist")
console.log("dist: ./charts renders dark PNG with the bundled Cyrillic font")

const { openOrdinaryFile, syncDirectory } = await import("@wirecat/cli-core/files")
const { preflightWavAudio, openWavAudio } = await import("@wirecat/cli-core/speech/wav")
const mediaFolder = mkdtempSync(join(tmpdir(), "cli-messaging-dist-media-"))
const mediaPath = join(mediaFolder, "AliceExample.wav")
const pcm = Buffer.alloc(44 + 32000)
pcm.write("RIFF", 0)
pcm.writeUInt32LE(pcm.length - 8, 4)
pcm.write("WAVEfmt ", 8)
pcm.writeUInt32LE(16, 16)
pcm.writeUInt16LE(1, 20)
pcm.writeUInt16LE(1, 22)
pcm.writeUInt32LE(16000, 24)
pcm.writeUInt32LE(32000, 28)
pcm.writeUInt16LE(2, 32)
pcm.writeUInt16LE(16, 34)
pcm.write("data", 36)
pcm.writeUInt32LE(32000, 40)
writeFileSync(mediaPath, pcm)
await syncDirectory(mediaFolder)
const ordinary = await openOrdinaryFile(mediaPath)
try {
  if ((await ordinary.stat()).size !== pcm.length) throw new Error("public ordinary-file helper failed")
} finally {
  await ordinary.close()
}
const mediaBudget = { maxBytes: 65536, maxDurationMs: 1000 }
const mediaPlan = await preflightWavAudio(mediaPath, mediaBudget)
const audio = await openWavAudio(mediaPlan, mediaBudget)
let sampleCount = 0
try {
  for await (const window of audio.windows()) sampleCount += window.samples.length
} finally {
  await audio.close()
}
if (sampleCount !== 16000 || mediaPlan.media.durationMs !== 1000 || JSON.stringify(mediaPlan).includes(mediaPath))
  throw new Error("public WAV streaming or path redaction failed from dist")
console.log("dist: ./files and ./speech/wav verify and decode an invented bounded file")

const { appUpdate } = await import("@wirecat/cli-core/update")
const update = appUpdate({
  packageName: "@wirecat/demo-cli",
  command: "demo",
  version: "1.0.0",
  entry: import.meta.url,
  statePath: () => join(mediaFolder, "update-check.json"),
  enabled: () => true,
  offVariables: [],
})
if (update.installer({ scriptPath: "/usr/lib/node_modules/@wirecat/demo-cli/dist/bin/demo.js" }) !== "npm")
  throw new Error("./update did not read the installer from the app's script")
console.log("dist: ./update reads an app's installer")

const { credentialStorage, oauthAccount, standardCodec } = await import("@wirecat/cli-core/oauth")
const { memoryKeyring } = await import("@wirecat/cli-base/testing")
const signIn = credentialStorage({
  credentials: { service: "demo-cli", configDir: mediaFolder, storage: "keyring", keyring: memoryKeyring() },
  account: oauthAccount("demo", "personal"),
  codec: standardCodec("demo"),
})
signIn.write({ tokens: { refreshToken: "invented", scopes: [] }, client: { clientId: "demo" } })
if (signIn.read()?.tokens.refreshToken !== "invented") throw new Error("./oauth did not read back an invented sign-in")
console.log("dist: ./oauth saves and reads an invented sign-in")
