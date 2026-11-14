import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it, vi } from "vitest"
import { aiKeys, aiSettingOf, aiSettingPath, writeAiSetting } from "../models/ai.js"
import { writeLocalOnly } from "../models/local-only.js"
import { type CloudSpeechDeps, cloudSpeech } from "./cloud.js"
import { SAMPLE_RATE } from "./recognize.js"

const app = { command: "pbx", appName: "asterisk-cli", envPrefix: "PBX", description: "", version: "1" }
const KEY = "sk-synthetic-cloud-7d1e"

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-speech-"))
  return {
    WIRECAT_STATE_DIR: root,
    WIRECAT_CONFIG_DIR: join(root, "wirecat"),
    MESSAGING_STORE: join(root, "store.db"),
    PBX_CONFIG_DIR: join(root, "config"),
    PBX_STATE_DIR: join(root, "state"),
  } as NodeJS.ProcessEnv
}

const call = { samples: new Float32Array(SAMPLE_RATE * 2), rate: SAMPLE_RATE }
const answering = () =>
  vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ text: "алло" })))

const setUp = (
  configured: Record<string, unknown>,
  { key = true, baseUrl }: { key?: boolean; baseUrl?: string } = {},
) => {
  const env = machine()
  const keyring = memoryKeyring()
  if (baseUrl) writeAiSetting(aiSettingPath(env), aiSettingOf({ provider: "openai", model: "gpt-5", baseUrl }))
  const origin = new URL(baseUrl ?? "https://api.openai.com").origin
  if (key) aiKeys(app, env, keyring).write(origin, KEY)
  const notify = vi.fn()
  const fetch = answering()
  const deps: CloudSpeechDeps = { app, env, keyring, settings: { configured }, notify, fetch }
  return { deps, notify, fetch, env }
}

describe("cloud speech for a host's recordings", () => {
  it("**is off unless the profile itself turns it on**", () => {
    expect(cloudSpeech(setUp({}).deps)).toBeNull()
    expect(cloudSpeech(setUp({ transcribeWith: "local" }).deps)).toBeNull()
  })

  it("**sends to OpenAI with the key kept for its address**, and says once that the audio leaves the computer", async () => {
    const { deps, notify, fetch } = setUp({ transcribeWith: "openai" })
    const speech = cloudSpeech(deps)

    expect(speech).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      leavesComputer: true,
      recognition: { engine: "openai", model: "gpt-transcribe" },
    })
    expect(notify).not.toHaveBeenCalled()
    expect(await speech?.recognize(call, { bundle: true })).toEqual([{ start: 0, end: 2, text: "алло" }])
    await speech?.recognize(call, { bundle: true })

    expect(notify.mock.calls).toEqual([
      ["the recordings' audio leaves this computer: it goes to api.openai.com (gpt-transcribe) to be transcribed"],
    ])
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({ authorization: `Bearer ${KEY}` })
    expect(JSON.stringify(notify.mock.calls)).not.toContain(KEY)
  })

  it("**goes to the shared AI model's compatible address**, with the profile's model and that address's key", async () => {
    const { deps, fetch } = setUp(
      { transcribeWith: "openai", transcribeModel: "whisper-large-v3" },
      { baseUrl: "https://speech.example.test/openai/v1" },
    )
    const speech = cloudSpeech(deps)

    expect(speech?.recognition).toEqual({ engine: "speech.example.test", model: "whisper-large-v3" })
    await speech?.recognize(call, { bundle: true })
    expect(fetch.mock.calls[0]?.[0]).toBe("https://speech.example.test/openai/v1/audio/transcriptions")
    expect((fetch.mock.calls[0]?.[1]?.body as FormData | undefined)?.get("model")).toBe("whisper-large-v3")
  })

  it("**names the address and the command when no key is kept for it**", () => {
    const { deps } = setUp({ transcribeWith: "openai" }, { key: false, baseUrl: "https://speech.example.test/v1" })

    expect(() => cloudSpeech(deps)).toThrow(
      "no key for speech.example.test — `pbx models ai set openai --base-url https://speech.example.test/v1 --secret-stdin`",
    )
  })

  it("**refuses with local only on**, and in a read-only process, before any audio is read", () => {
    const local = setUp({ transcribeWith: "openai" })
    writeLocalOnly(local.env, true)
    expect(() => cloudSpeech(local.deps)).toThrow("local only is on")

    const readOnly = setUp({ transcribeWith: "openai" })
    expect(() => cloudSpeech({ ...readOnly.deps, env: { ...readOnly.deps.env, PBX_READ_ONLY: "1" } })).toThrow(
      "read-only",
    )
  })

  it("needs no key for a compatible server on this computer, and says the audio stays here", async () => {
    const { deps, notify, fetch } = setUp(
      { transcribeWith: "openai", transcribeModel: "small" },
      { key: false, baseUrl: "http://127.0.0.1:8000/v1" },
    )
    const speech = cloudSpeech(deps)

    expect(speech?.leavesComputer).toBe(false)
    await speech?.recognize(call, { bundle: true })
    expect(fetch.mock.calls[0]?.[1].headers).toEqual({})
    expect(notify.mock.calls[0]?.[0]).toContain("on this computer")
  })

  it("names the compatible service in its errors, not OpenAI", async () => {
    const { deps } = setUp({ transcribeWith: "openai" }, { baseUrl: "https://speech.example.test/v1" })
    const refusing = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401 }),
    )

    await expect(cloudSpeech({ ...deps, fetch: refusing })?.recognize(call, { bundle: true })).rejects.toThrow(
      "speech.example.test refused the key (HTTP 401, invalid_api_key) — set it again with `pbx models ai set openai --base-url",
    )
  })
})
