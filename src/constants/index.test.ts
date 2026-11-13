import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { hostCovered, hostProblems } from "@wirecat/cli-base/http"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import {
  CORE_HOSTS,
  constants,
  constantsSchema,
  googleApp,
  microsoftApp,
  oauthApp,
  oauthClientReport,
} from "./index.js"

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
  it("prefers the client file, then --client-id, the environment, the account's config, then WireCat's app", () => {
    const file = join(folder(), "client.json")
    writeFileSync(file, JSON.stringify({ installed: { client_id: "file-id", client_secret: "s3cret" } }))
    chmodSync(file, 0o600)
    const env = { GCAL_GOOGLE_CLIENT_ID: "env-id", GCAL_GOOGLE_CLIENT_SECRET: "env-secret" }
    const pick = (options: Partial<Parameters<typeof googleApp>[0]>) =>
      googleApp({ env: {}, prefix: "GCAL", ...options }).client

    expect(pick({ env, clientFile: file, clientId: "flag-id" })).toEqual({
      clientId: "file-id",
      clientSecret: "s3cret",
      source: "flag",
    })
    expect(pick({ env, clientId: "flag-id" })).toEqual({
      clientId: "flag-id",
      clientSecret: "env-secret",
      source: "flag",
    })
    expect(pick({ env, configClientId: "config-id" })).toEqual({
      clientId: "env-id",
      clientSecret: "env-secret",
      source: "env",
    })
    expect(pick({ configClientId: "config-id" })).toEqual({ clientId: "config-id", source: "config" })
    expect(googleApp({ env: {}, prefix: "GCAL" })).toEqual({
      client: {
        clientId: constants().google.app.client_id,
        clientSecret: constants().google.app.client_secret,
        source: "constants",
      },
      source: "constants",
    })
  })

  it("refuses a secret without a client id", () => {
    expect(() => googleApp({ env: { DRIVE_GOOGLE_CLIENT_SECRET: "s3cret" }, prefix: "DRIVE" })).toThrow(
      expect.objectContaining({
        code: "configuration_error",
        details: { reason: "sign-in.secret-without-id" },
        message: expect.stringMatching(/DRIVE_GOOGLE_CLIENT_ID/),
      }),
    )
  })
})

describe("oauthApp", () => {
  it("has no app for a provider WireCat has none for, and doctor says why", () => {
    const none = oauthApp({ env: {}, prefix: "ZOOM", provider: "zoom", wirecat: { client_id: "" } })

    expect(none).toBeUndefined()
    expect(oauthClientReport(none, "no WireCat Zoom app yet")).toEqual({
      client: null,
      source: null,
      reason: "no WireCat Zoom app yet",
    })
    expect(
      oauthClientReport(oauthApp({ env: { ZOOM_ZOOM_CLIENT_ID: "z" }, prefix: "ZOOM", provider: "zoom" })),
    ).toEqual({ client: "own", source: "env" })
  })

  it("gives Microsoft WireCat's public client, with no secret", () => {
    const app = microsoftApp({ env: {}, prefix: "MAIL" })

    expect(app.client).toEqual({ clientId: constants().microsoft.app.client_id, source: "constants" })
    expect(oauthClientReport(app)).toEqual({ client: "wirecat", source: "constants" })
    expect(microsoftApp({ env: { MAIL_MICROSOFT_CLIENT_ID: "own" }, prefix: "MAIL" }).source).toBe("env")
  })
})

it("CORE_HOSTS covers every fixed host the update, the model calls and the model downloads reach", () => {
  const sources = [
    "models/ai.ts",
    "embeddings/remote.ts",
    "embeddings/models.ts",
    "embeddings/onnx-runtime.ts",
    "speech/models.ts",
  ]
  const named = sources.flatMap((path) =>
    [...readFileSync(new URL(`../${path}`, import.meta.url), "utf8").matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(
      ([, host]) => host as string,
    ),
  )
  const fetched = [...new Set(named)].filter((host) => host !== "ai.google.dev")

  expect(hostProblems(CORE_HOSTS)).toEqual([])
  expect(fetched.filter((host) => !hostCovered(host, CORE_HOSTS))).toEqual([])
})
