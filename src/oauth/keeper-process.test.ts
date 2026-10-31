import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { expect, it } from "vitest"

// A keyring both processes see: the in-memory one lives in one process only.
const child = (module: string) => `
  const { readFileSync, renameSync, writeFileSync } = await import("node:fs");
  const { tokenKeeper, credentialStorage, zoomTokenCodec } = await import(${JSON.stringify(module)});
  const { keyringFile, configDir, tokenUrl } = JSON.parse(process.argv[1]);
  const entries = () => JSON.parse(readFileSync(keyringFile, "utf8"));
  const keyring = {
    get: (service, account) => entries()[service + "|" + account] ?? null,
    set: (service, account, secret) => {
      const next = { ...entries(), [service + "|" + account]: secret };
      writeFileSync(keyringFile + "." + process.pid, JSON.stringify(next));
      renameSync(keyringFile + "." + process.pid, keyringFile);
    },
    delete: () => false,
  };
  const note = (event) => { if (event.outcome === "waiting") process.send({ waiting: true }) };
  const keeper = tokenKeeper({
    provider: { id: "zoom", name: "Zoom", authorizeUrl: tokenUrl, tokenUrl, client: { clientId: "zm-client" }, redirect: { kind: "loopback" } },
    storage: credentialStorage({
      credentials: { service: "zoom-cli", configDir, storage: "keyring", keyring },
      account: "zm-client:personal",
      codec: zoomTokenCodec,
    }),
    lockDir: configDir,
    fetch,
    signInCommand: "zm personal session start",
    lockRetryMs: 5,
    log: { debug() {}, info: note, warn: note, error: note },
  });
  process.send({ token: await keeper.accessToken() });
  process.disconnect();
`

const message = (process: ChildProcess, key: string) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const listen = (value: Record<string, unknown>) => {
      if (!(key in value)) return
      process.off("message", listen)
      resolve(value)
    }
    process.on("message", listen)
    process.once("exit", (code) => reject(new Error(`child exited ${code} before ${key}`)))
  })

it("two processes refreshing one entry at once send one refresh, and both get its token", async () => {
  const folder = await mkdtemp(join(tmpdir(), "core-test-oauth-process-"))
  const module = join(folder, "oauth.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    outfile: module,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    plugins: [
      {
        name: "public-base-entry",
        setup(builder) {
          builder.onResolve({ filter: /^@wirecat\/cli-base$/ }, () => ({
            path: import.meta.resolve("@wirecat/cli-base"),
            external: true,
          }))
        },
      },
    ],
  })
  const configDir = join(folder, "config")
  const keyringFile = join(folder, "keyring.json")
  const account = "zoom-cli|zm-client:personal"
  await writeFile(
    keyringFile,
    JSON.stringify({
      [account]: JSON.stringify({
        accessToken: "old",
        refreshToken: "synthetic-refresh-1",
        expiresAt: 0,
        scopes: ["m"],
      }),
    }),
  )

  const requests: URLSearchParams[] = []
  let answerFirst: () => void = () => {}
  let arrived: () => void = () => {}
  const firstArrived = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push(new URLSearchParams(body))
    const reply = () =>
      response.setHeader("content-type", "application/json").end(
        JSON.stringify({
          access_token: "synthetic-access-new",
          refresh_token: "synthetic-refresh-2",
          expires_in: 3600,
        }),
      )
    if (requests.length > 1) return reply()
    answerFirst = reply
    arrived()
  })
  server.listen(0, "127.0.0.1")
  server.unref()
  await once(server, "listening")
  const tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`
  const argument = JSON.stringify({ keyringFile, configDir, tokenUrl })
  const run = () =>
    spawn(process.execPath, ["--input-type=module", "--eval", child(pathToFileURL(module).href), argument], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    })

  const first = run()
  const exits = [once(first, "exit")]
  let second: ChildProcess | undefined
  try {
    const firstToken = message(first, "token")
    await firstArrived
    second = run()
    exits.push(once(second, "exit"))
    const secondToken = message(second, "token")
    await message(second, "waiting")
    answerFirst()

    expect(await firstToken).toEqual({ token: "synthetic-access-new" })
    expect(await secondToken).toEqual({ token: "synthetic-access-new" })
    await Promise.all(exits)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.get("refresh_token")).toBe("synthetic-refresh-1")
    const saved = JSON.parse(JSON.parse(await readFile(keyringFile, "utf8"))[account])
    expect(saved).toMatchObject({
      accessToken: "synthetic-access-new",
      refreshToken: "synthetic-refresh-2",
      scopes: ["m"],
    })
  } finally {
    for (const spawned of [first, second])
      if (spawned && spawned.exitCode === null && spawned.signalCode === null) spawned.kill()
    server.close()
  }
})
