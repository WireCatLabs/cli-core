import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { constants, constantsSchema, googleApp } from "./index.js"

const folder = () => mkdtempSync(join(tmpdir(), "core-constants-"))

describe("constants", () => {
  it("ships WireCat's Google and Microsoft apps, frozen and read once", () => {
    const shipped = constants()

    expect(shipped.google.app.client_id).toMatch(/\.apps\.googleusercontent\.com$/)
    expect(shipped.microsoft.app.client_id).not.toBe("")
    expect(Object.isFrozen(shipped.google.app)).toBe(true)
    expect(constants()).toBe(shipped)
  })

  it("lets a tool add its layer and extend the schema", () => {
    const layer = join(folder(), "constants.json")
    writeFileSync(
      layer,
      JSON.stringify({ zoom: { app: { client_id: "zoom" } }, microsoft: { app: { client_id: "own" } } }),
    )
    const schema = v.object({
      ...constantsSchema.entries,
      zoom: v.object({ app: v.object({ client_id: v.string() }) }),
    })

    const tool = constants(pathToFileURL(layer), schema)

    expect(tool.zoom.app.client_id).toBe("zoom")
    expect(tool.microsoft.app.client_id).toBe("own")
    expect(tool.google.app.client_id).toBe(constants().google.app.client_id)
  })
})

describe("googleApp", () => {
  it("prefers the client file, then the environment, then WireCat's app", () => {
    const file = join(folder(), "client.json")
    writeFileSync(file, JSON.stringify({ installed: { client_id: "file-id", client_secret: "s3cret" } }))
    chmodSync(file, 0o600)
    const env = { GCAL_GOOGLE_CLIENT_ID: "env-id" }

    expect(googleApp({ env, prefix: "GCAL", clientFile: file })).toEqual({
      client: { clientId: "file-id", clientSecret: "s3cret" },
      source: "file",
    })
    expect(googleApp({ env, prefix: "GCAL" })).toEqual({ client: { clientId: "env-id" }, source: "env" })
    expect(googleApp({ env: {}, prefix: "GCAL" })).toEqual({
      client: { clientId: constants().google.app.client_id, clientSecret: constants().google.app.client_secret },
      source: "wirecat",
    })
  })

  it("refuses a secret without its client id", () => {
    expect(() => googleApp({ env: { DRIVE_GOOGLE_CLIENT_SECRET: "s3cret" }, prefix: "DRIVE" })).toThrow(
      expect.objectContaining({
        code: "configuration_error",
        message: expect.stringMatching(/DRIVE_GOOGLE_CLIENT_ID/),
      }),
    )
  })
})
