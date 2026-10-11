import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-core"
import { describe, expect, it } from "vitest"
import type { RecordingAssetLocator } from "./recording-source.js"
import {
  type RecordingPartial,
  type RecordingTransferResponse,
  type RecordingTransferStorage,
  strongRecordingValidator,
  transferRecording,
} from "./recording-transfer.js"
import { recordingTransferStorageContract } from "./testing/recording-transfer-contract.js"

const locator: RecordingAssetLocator = {
  provider: "example-video",
  account: "AliceExample",
  occurrenceId: "example-occurrence",
  assetId: "example-video",
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const bytes = (text: string) => new TextEncoder().encode(text)
const response = (
  status = 200,
  body = "abcdef",
  headers: Partial<RecordingTransferResponse> = {},
): RecordingTransferResponse => ({
  status,
  etag: '"example-v1"',
  contentLength: String(body.length),
  contentRange: null,
  body: {
    async *[Symbol.asyncIterator]() {
      yield bytes(body)
    },
  },
  close: async () => {},
  ...headers,
})
const memory = (text = "", overrides: Partial<RecordingPartial> = {}) => {
  let content = bytes(text)
  let saved: RecordingPartial | null = text
    ? { locator, offset: content.length, sha256: sha(content), validator: '"example-v1"', total: 6, ...overrides }
    : null
  let opened = 0
  const storage: RecordingTransferStorage = {
    load: async () => saved,
    open: async (selectedLocator, options) => {
      opened++
      if (!options.resume) content = bytes("")
      return {
        write: async (chunk) => {
          content = new Uint8Array([...content, ...chunk])
        },
        checkpoint: async () => {
          if (options.validator)
            saved = {
              locator: selectedLocator,
              offset: content.length,
              sha256: sha(content),
              validator: options.validator,
              total: options.total,
            }
        },
        finish: async () => {
          if (options.validator)
            saved = {
              locator: selectedLocator,
              offset: content.length,
              sha256: sha(content),
              validator: options.validator,
              total: options.total,
            }
          return { size: content.length, sha256: sha(content) }
        },
        close: async () => {},
      }
    },
  }
  return { storage, content: () => new TextDecoder().decode(content), opened: () => opened }
}
const options = { locator, maxBytes: 10, expectedSize: 6 }
const run = (
  reply: RecordingTransferResponse,
  state = memory(),
  opts: Parameters<typeof transferRecording>[2] = options,
) => transferRecording({ open: async () => reply }, state.storage, opts)
describe("provider-neutral recording transfer", () => {
  it("streams a second provider without provider types", async () => {
    const state = memory()
    expect(await run(response(), state)).toEqual({ size: 6, sha256: sha(bytes("abcdef")), resumedBytes: 0 })
    expect(state.content()).toBe("abcdef")
  })
  it("checkpoints interrupted prefixes and resumes after reopening", async () => {
    const state = memory()
    const broken = response(200, "abcdef", {
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes("abc")
          throw new Error("interrupted")
        },
      },
    })
    await expect(run(broken, state)).rejects.toThrow("interrupted")
    const requests: unknown[] = []
    const result = await transferRecording(
      {
        open: async (request) => {
          requests.push(request)
          return response(206, "def", { contentRange: "bytes 3-5/6" })
        },
      },
      state.storage,
      options,
    )
    expect(result.resumedBytes).toBe(3)
    expect(requests).toEqual([{ locator, offset: 3, validator: '"example-v1"' }])
    expect(state.content()).toBe("abcdef")
  })
  it.each([null, 'W/"weak"', "invalid", '"bad\n"'])("only strong validators can resume: %s", async (validator) => {
    expect(strongRecordingValidator(validator)).toBe(false)
    const state = memory("abc", { validator: validator ?? "" })
    expect((await run(response(), state)).resumedBytes).toBe(0)
  })
  it("uses independently declared asset size to resume a chunked response", async () => {
    const state = memory()
    await expect(
      run(
        response(200, "abcdef", {
          contentLength: null,
          body: {
            async *[Symbol.asyncIterator]() {
              yield bytes("abc")
              throw new Error("interrupted")
            },
          },
        }),
        state,
      ),
    ).rejects.toThrow("interrupted")
    const result = await run(response(206, "def", { contentRange: "bytes 3-5/6" }), state)
    expect(result.resumedBytes).toBe(3)
    expect(state.content()).toBe("abcdef")
  })
  it("restarts safely when the server ignores range", async () => {
    const state = memory("abc")
    expect((await run(response(), state)).resumedBytes).toBe(0)
    expect(state.content()).toBe("abcdef")
  })
  it.each([null, 'W/"weak"', '"changed"'])("restarts after changed or missing 206 validator %s", async (etag) => {
    const state = memory("abc")
    let calls = 0
    const result = await transferRecording(
      { open: async () => (++calls === 1 ? response(206, "def", { etag, contentRange: "bytes 3-5/6" }) : response()) },
      state.storage,
      options,
    )
    expect(calls).toBe(2)
    expect(result.resumedBytes).toBe(0)
  })
  it("validates a resumed unknown total against the response with cancellation supplied", async () => {
    const state = memory("abc", { total: null })
    const controller = new AbortController()
    const result = await transferRecording(
      { open: async () => response(206, "def", { contentRange: "bytes 3-5/6", contentLength: null }) },
      state.storage,
      { locator, maxBytes: 10, signal: controller.signal },
    )
    expect(result.resumedBytes).toBe(3)
  })
  it("accepts 416 only for a fully verified exact total", async () => {
    const state = memory("abcdef")
    expect((await run(response(416, "", { contentRange: "bytes */6" }), state)).resumedBytes).toBe(6)
  })
  it("restarts on untrusted 416 total", async () => {
    const state = memory("abc")
    let calls = 0
    expect(
      (
        await transferRecording(
          { open: async () => (++calls === 1 ? response(416, "", { contentRange: "bytes */9" }) : response()) },
          state.storage,
          options,
        )
      ).resumedBytes,
    ).toBe(0)
  })
  it.each([
    "bytes 2-5/6",
    "bytes 3-2/3",
    "bytes 3-4/6",
    "bytes 3-5/*",
    "bytes 3-5/7",
    "bytes 3-5/9007199254740992",
    null,
  ])("rejects unsafe ranges %s before append", async (contentRange) => {
    const state = memory("abc")
    await expect(run(response(206, "def", { contentRange }), state)).rejects.toThrow("range")
    expect(state.opened()).toBe(0)
  })
  it.each(["4", "n/a", "9007199254740992"])("rejects range length %s", async (contentLength) => {
    await expect(
      run(response(206, "def", { contentRange: "bytes 3-5/6", contentLength }), memory("abc")),
    ).rejects.toThrow()
  })
  it.each([206, 404, 500])("rejects unsolicited status %s", async (status) => {
    await expect(run(response(status))).rejects.toThrow("response")
  })
  it("rejects a 200 content-range", async () => {
    await expect(run(response(200, "abcdef", { contentRange: "bytes 0-5/6" }))).rejects.toThrow("range")
  })
  it.each(["5", "11"])("rejects unexpected total %s", async (contentLength) => {
    await expect(run(response(200, "abcdef", { contentLength }))).rejects.toThrow("size")
  })
  it("rejects truncation and overflow without final promotion", async () => {
    await expect(run(response(200, "abc", { contentLength: "6" }))).rejects.toThrow("truncated")
    await expect(run(response(200, "abcdefghi", { contentLength: "6" }))).rejects.toThrow("size")
  })
  it("allows unknown totals but enforces the byte limit", async () => {
    const state = memory()
    expect(
      (
        await run(response(200, "abcdef", { contentLength: null }), state, {
          locator,
          maxBytes: 10,
          expectedSize: null,
        })
      ).size,
    ).toBe(6)
    await expect(
      run(response(200, "abcdef", { contentLength: null }), memory(), {
        locator,
        maxBytes: 3,
        expectedSize: null,
      }),
    ).rejects.toThrow("size")
  })
  it.each([
    { locator: { ...locator, account: "BobSample" } },
    { offset: 0 },
    { offset: 11 },
    { offset: 0.5 },
    { sha256: "bad" },
    { total: 2 },
    { total: 11 },
    { total: 5 },
  ])("discards an invalid partial %j", async (override) => {
    expect((await run(response(), memory("abc", override))).resumedBytes).toBe(0)
  })
  it.each([0, -1, 0.5, Number.NaN])("validates max bytes %s before opening", async (maxBytes) => {
    await expect(run(response(), memory(), { ...options, maxBytes })).rejects.toThrow("options")
  })
  it("validates scope and expected sizes before opening", async () => {
    await expect(
      run(response(), memory(), { ...options, locator: { ...locator, account: " " } }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(run(response(), memory(), { ...options, expectedSize: 11 })).rejects.toThrow("options")
    await expect(run(response(), memory(), { ...options, expectedSize: -1 })).rejects.toThrow("options")
  })
  it("honors cancellation before IO and while streaming", async () => {
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(run(response(), memory(), { ...options, signal: controller.signal })).rejects.toThrow("cancelled")
    const next = new AbortController()
    const state = memory()
    await expect(
      run(
        response(200, "abcdef", {
          body: {
            async *[Symbol.asyncIterator]() {
              yield bytes("abc")
              next.abort(new Error("cancelled"))
              yield bytes("def")
            },
          },
        }),
        state,
        { ...options, signal: next.signal },
      ),
    ).rejects.toThrow("cancelled")
    expect(state.content()).toBe("abc")
  })
})

for (const contract of recordingTransferStorageContract(() => {
  const state = memory()
  return { storage: state.storage, reopen: async () => ({ ...state.storage }) }
}))
  it(contract.name, contract.run)

it.each([{ size: 5, sha256: "a".repeat(64) }, { size: 6, sha256: "bad" }, null])(
  "rejects incorrect host completion receipt %j",
  async (invalid) => {
    const state = memory()
    const open = state.storage.open.bind(state.storage)
    state.storage.open = async (...args) => ({
      ...(await open(...args)),
      finish: async () => invalid as unknown as { size: number; sha256: string },
    })
    await expect(run(response(), state)).rejects.toThrow("storage receipt")
  },
)
it("rejects a different completed-prefix digest from a 416 host receipt", async () => {
  const state = memory("abcdef")
  const open = state.storage.open.bind(state.storage)
  state.storage.open = async (...args) => ({
    ...(await open(...args)),
    finish: async () => ({ size: 6, sha256: "a".repeat(64) }),
  })
  await expect(run(response(416, "", { contentRange: "bytes */6" }), state)).rejects.toThrow("storage receipt")
})
it("snapshots partial metadata before the source awaits or changes it", async () => {
  const state = memory("abc")
  const loaded = await state.storage.load(locator)
  if (!loaded) throw new Error("missing fixture")
  const source = {
    open: async () => {
      loaded.offset = 0
      loaded.total = 1
      loaded.locator = { ...locator, account: "BobSample" }
      return response(206, "def", { contentRange: "bytes 3-5/6" })
    },
  }
  expect((await transferRecording(source, state.storage, options)).resumedBytes).toBe(3)
})
it("snapshots response getters, body and close method before a host await", async () => {
  const state = memory()
  const reply = response()
  let reads = 0
  let closed = 0
  reply.close = async () => {
    closed++
  }
  Object.defineProperty(reply, "etag", {
    get: () => {
      reads++
      return reads === 1 ? '"example-v1"' : '"changed"'
    },
  })
  const open = state.storage.open.bind(state.storage)
  state.storage.open = async (...args) => {
    expect(args[1].validator).toBe('"example-v1"')
    reply.body = response(200, "bad").body
    reply.close = async () => {
      throw new Error("mutated close")
    }
    return open(...args)
  }
  expect((await run(reply, state)).size).toBe(6)
  expect(state.content()).toBe("abcdef")
  expect(reads).toBe(1)
  expect(closed).toBe(1)
})
it("closes a response if a metadata getter throws while capturing it", async () => {
  const reply = response()
  let closed = 0
  reply.close = async () => {
    closed++
  }
  Object.defineProperty(reply, "status", {
    get: () => {
      throw new Error("invalid source metadata")
    },
  })
  await expect(run(reply)).rejects.toThrow("invalid source metadata")
  expect(closed).toBe(1)
})
it("preserves an acknowledged receipt when cancellation follows atomic finish", async () => {
  const state = memory()
  const controller = new AbortController()
  const open = state.storage.open.bind(state.storage)
  state.storage.open = async (...args) => {
    const writer = await open(...args)
    return {
      ...writer,
      finish: async () => {
        const result = await writer.finish()
        controller.abort()
        return result
      },
    }
  }
  expect((await run(response(), state, { ...options, signal: controller.signal })).size).toBe(6)
})

it("reports standard validation, source and cancellation errors", async () => {
  await expect(run(response(), memory(), { ...options, maxBytes: 0 })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(run(response(404))).rejects.toMatchObject({ code: "invalid_response" })
  const controller = new AbortController()
  controller.abort()
  await expect(run(response(), memory(), { ...options, signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  })
  const timeout = new CliError("timeout", "example deadline")
  const deadline = new AbortController()
  deadline.abort(timeout)
  await expect(run(response(), memory(), { ...options, signal: deadline.signal })).rejects.toBe(timeout)
})

it("bounds validators and locator control characters while accepting common account capacities", async () => {
  expect(strongRecordingValidator(`"${"x".repeat(1023)}"`)).toBe(false)
  const other = { ...locator, account: "A".repeat(1000) }
  expect((await run(response(), memory(), { ...options, locator: other })).size).toBe(6)
  await expect(
    run(response(), memory(), { ...options, locator: { ...locator, assetId: "example\nasset" } }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("restarts a 416 missing total metadata with the original cancellation signal", async () => {
  const state = memory("abc")
  const controller = new AbortController()
  let calls = 0
  const result = await transferRecording(
    {
      open: async (request) => {
        expect(request.signal).toBe(controller.signal)
        return ++calls === 1 ? response(416, "", { contentRange: null }) : response()
      },
    },
    state.storage,
    { ...options, signal: controller.signal },
  )
  expect(result.resumedBytes).toBe(0)
  expect(calls).toBe(2)
})
it("retains cancellation policy while reopening a changed representation", async () => {
  const state = memory("abc")
  const controller = new AbortController()
  let calls = 0
  const result = await transferRecording(
    {
      open: async (request) => {
        expect(request.signal).toBe(controller.signal)
        return ++calls === 1 ? response(206, "def", { contentRange: "bytes 3-5/6", etag: '"changed"' }) : response()
      },
    },
    state.storage,
    { ...options, signal: controller.signal },
  )
  expect(result.resumedBytes).toBe(0)
  expect(calls).toBe(2)
})
it.each([null, 'W/"weak"', `"${"x".repeat(1023)}"`])(
  "a fresh response without a bounded strong validator keeps no resumable state: %s",
  async (etag) => {
    const state = memory()
    expect((await run(response(200, "abcdef", { etag }), state)).size).toBe(6)
    expect(await state.storage.load(locator)).toBeNull()
  },
)
