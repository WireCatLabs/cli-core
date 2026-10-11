import { CliError } from "@wirecat/cli-base"
import { snapshotMeetingScope } from "./provider.js"
import type { RecordingAssetLocator } from "./recording-source.js"

export interface RecordingPartial {
  locator: RecordingAssetLocator
  offset: number
  sha256: string
  validator: string
  total: number | null
}
export interface RecordingTransferResponse {
  status: number
  etag: string | null
  contentRange: string | null
  contentLength: string | null
  body: AsyncIterable<Uint8Array>
  close(): Promise<void>
}
export interface RecordingTransferSource {
  open(options: {
    locator: RecordingAssetLocator
    offset?: number
    validator?: string
    signal?: AbortSignal
  }): Promise<RecordingTransferResponse>
}
export interface RecordingTransferWriter {
  write(bytes: Uint8Array): Promise<void>
  checkpoint(): Promise<void>
  finish(): Promise<{ size: number; sha256: string }>
  close(): Promise<void>
}
export interface RecordingTransferStorage {
  /** The host verifies the exact prefix digest and file identity before returning a partial. */
  load(locator: RecordingAssetLocator): Promise<RecordingPartial | null>
  /** A missing resume starts a new file; the host must never truncate a previously verified final file. */
  open(
    locator: RecordingAssetLocator,
    options: { resume?: RecordingPartial; validator: string | null; total: number | null },
  ): Promise<RecordingTransferWriter>
}
export class RecordingTransferError extends CliError {
  constructor(message: string, code: "invalid_response" | "validation_error" | "cancelled" = "invalid_response") {
    super(code, message)
    this.name = "RecordingTransferError"
  }
}
export const strongRecordingValidator = (value: string | null): value is string =>
  typeof value === "string" && value.length <= 1024 && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)
const fail = (message: string, code: "invalid_response" | "validation_error" = "invalid_response"): never => {
  throw new RecordingTransferError(message, code)
}
const integer = (value: string | null): number | null => {
  if (value === null) return null
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    return fail("invalid recording content length")
  return Number(value)
}
const cancelled = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  throw new RecordingTransferError("recording transfer cancelled", "cancelled")
}
const sameLocator = (a: RecordingAssetLocator, b: RecordingAssetLocator) =>
  a.provider === b.provider && a.account === b.account && a.occurrenceId === b.occurrenceId && a.assetId === b.assetId
const receipt = (value: { size: number; sha256: string }, expectedSize: number, expectedHash?: string) => {
  if (typeof value !== "object" || value === null) return fail("invalid recording storage receipt")
  const { size, sha256 } = value
  if (
    size !== expectedSize ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    (expectedHash !== undefined && sha256 !== expectedHash)
  )
    return fail("invalid recording storage receipt")
  return { size, sha256 }
}
export const transferRecording = async (
  source: RecordingTransferSource,
  storage: RecordingTransferStorage,
  options: { locator: RecordingAssetLocator; maxBytes: number; expectedSize?: number | null; signal?: AbortSignal },
): Promise<{ size: number; sha256: string; resumedBytes: number }> => {
  const { maxBytes, signal, expectedSize } = options
  const inputLocator = options.locator
  const fixedScope = snapshotMeetingScope(inputLocator)
  const locator = Object.freeze({
    provider: fixedScope.provider,
    account: fixedScope.account,
    occurrenceId: inputLocator.occurrenceId,
    assetId: inputLocator.assetId,
  })
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    [locator.occurrenceId, locator.assetId].some(
      (value) => typeof value !== "string" || !value.trim() || value.length > 512 || /[\0\r\n]/.test(value),
    ) ||
    (expectedSize != null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > maxBytes))
  )
    fail("invalid recording transfer options", "validation_error")
  cancelled(signal)
  const loaded = await storage.load(locator)
  const loadedLocator = loaded?.locator
  let partial: RecordingPartial | null =
    loaded && loadedLocator
      ? Object.freeze({
          locator: Object.freeze({
            provider: loadedLocator.provider,
            account: loadedLocator.account,
            occurrenceId: loadedLocator.occurrenceId,
            assetId: loadedLocator.assetId,
          }),
          offset: loaded.offset,
          sha256: loaded.sha256,
          validator: loaded.validator,
          total: loaded.total,
        })
      : null
  if (
    partial &&
    (!sameLocator(partial.locator, locator) ||
      !strongRecordingValidator(partial.validator) ||
      !Number.isSafeInteger(partial.offset) ||
      partial.offset <= 0 ||
      partial.offset > maxBytes ||
      !/^[a-f0-9]{64}$/.test(partial.sha256) ||
      (partial.total !== null &&
        (!Number.isSafeInteger(partial.total) || partial.total < partial.offset || partial.total > maxBytes)) ||
      (expectedSize != null && partial.total !== expectedSize))
  )
    partial = null
  cancelled(signal)
  const openResponse = async (request: Parameters<RecordingTransferSource["open"]>[0]) => {
    const opened = await source.open(request)
    const close = opened.close.bind(opened)
    try {
      return Object.freeze({
        status: opened.status,
        etag: opened.etag,
        contentRange: opened.contentRange,
        contentLength: opened.contentLength,
        body: opened.body,
        close,
      })
    } catch (error) {
      await close()
      throw error
    }
  }
  let response = await openResponse({
    locator,
    ...(partial ? { offset: partial.offset, validator: partial.validator } : {}),
    ...(signal ? { signal } : {}),
  })
  try {
    cancelled(signal)
    if (partial && response.status === 416) {
      const match = /^bytes \*\/(\d+)$/.exec(response.contentRange ?? "")
      if (
        match &&
        Number(match[1]) === partial.offset &&
        partial.total === partial.offset &&
        response.etag === partial.validator
      ) {
        const writer = await storage.open(locator, {
          resume: partial,
          validator: partial.validator,
          total: partial.total,
        })
        try {
          cancelled(signal)
          return { ...receipt(await writer.finish(), partial.offset, partial.sha256), resumedBytes: partial.offset }
        } finally {
          await writer.close()
        }
      }
      await response.close()
      partial = null
      response = await openResponse({ locator, ...(signal ? { signal } : {}) })
    }
    if (partial && response.status === 206 && response.etag !== partial.validator) {
      await response.close()
      partial = null
      response = await openResponse({ locator, ...(signal ? { signal } : {}) })
      cancelled(signal)
    }
    let total: number | null = null
    const length = integer(response.contentLength)
    if (response.status === 206 && partial) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.contentRange ?? "")
      if (!match) return fail("invalid recording content range")
      const start = Number(match[1])
      const end = Number(match[2])
      const size = Number(match[3])
      if (
        !Number.isSafeInteger(size) ||
        start !== partial.offset ||
        end < start ||
        end !== size - 1 ||
        (partial.total !== null && size !== partial.total) ||
        (length !== null && length !== end - start + 1)
      )
        fail("recording range does not match its verified prefix")
      total = size
    } else if (response.status === 200) {
      partial = null
      if (response.contentRange !== null) fail("unexpected recording content range")
      total = length ?? expectedSize ?? null
    } else fail("recording transfer requires a complete response or validated range")
    if (total !== null && (total > maxBytes || (expectedSize != null && total !== expectedSize)))
      fail("recording size does not match transfer limits")
    const writer = await storage.open(locator, {
      ...(partial ? { resume: partial } : {}),
      validator: strongRecordingValidator(response.etag) ? response.etag : null,
      total,
    })
    const resumedBytes = partial?.offset ?? 0
    let size = resumedBytes
    try {
      for await (const bytes of response.body) {
        cancelled(signal)
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > maxBytes - size ||
          (total !== null && bytes.byteLength > total - size)
        )
          fail("recording exceeds transfer size")
        await writer.write(bytes)
        size += bytes.byteLength
        await writer.checkpoint()
      }
      cancelled(signal)
      if ((total !== null && size !== total) || (expectedSize != null && size !== expectedSize))
        fail("recording body was truncated")
      return { ...receipt(await writer.finish(), size), resumedBytes }
    } finally {
      await writer.close()
    }
  } finally {
    await response.close()
  }
}
