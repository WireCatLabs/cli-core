import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { expect, it } from "vitest"
import { nativeWriterLeaseStore } from "./index.js"

it("contends with a real second process through a root alias and recovers its abandoned lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-test-process-lease-"))
  const aliasParent = await mkdtemp(join(tmpdir(), "core-test-process-alias-"))
  const alias = join(aliasParent, "archive")
  await symlink(root, alias, "junction")
  const module = join(aliasParent, "lease.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./native-writer-lease.ts", import.meta.url))],
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
  const layout = { markerDirectory: ".example-meeting-writers" }
  const store = nativeWriterLeaseStore(layout)
  const program = `
    const { nativeWriterLeaseStore } = await import(${JSON.stringify(pathToFileURL(module).href)});
    const held = await nativeWriterLeaseStore(${JSON.stringify(layout)}).acquire(${JSON.stringify(root)});
    if (held.status !== 'acquired') throw Error('child could not acquire');
    process.once('message', async command => {
      if (command === 'release') await held.lease.release();
      process.disconnect();
    });
    process.send({ status: held.status, pid: process.pid });
  `
  for (const command of ["release", "abandon"]) {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    const exited = once(child, "exit")
    try {
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(5000) })
      expect(ready).toEqual({ status: "acquired", pid: child.pid })
      expect(await store.acquire(alias)).toMatchObject({
        status: "busy",
        locks: [{ status: "active", pid: child.pid }],
      })
      child.send(command)
      expect(await exited).toEqual([0, null])
      if (command === "abandon") expect(await store.inspect(root)).toMatchObject([{ status: "stale", pid: child.pid }])
      const next = await store.acquire(alias)
      if (next.status !== "acquired") throw new Error("root remained locked")
      await next.lease.release()
      expect(await store.inspect(root)).toEqual([])
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited
    }
  }
})
