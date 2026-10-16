import { createHash, randomUUID } from "node:crypto"
import { type FileHandle, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { openOrdinaryFile } from "../../files/index.js"
import type {
  RecordingAssetLocator,
  RecordingPartial,
  RecordingTransferStorage,
  RecordingTransferWriter,
} from "../../meetings/index.js"
import { fingerprintPartial, missing, partialIdentity, readPartialMetadata } from "./recording-partial-metadata.js"
import { partialWriter } from "./recording-partial-writer.js"

export interface NativeRecordingPartialOptions {
  /** Host-owned dotfile prefix, for example `.example-partial-`. */
  prefix: string
  persistent: boolean
  maxBytes: number
  signal?: AbortSignal
}

/** The caller holds the root writer lease throughout load, open and publication. */
export class NativeRecordingPartialStore implements RecordingTransferStorage {
  readonly path: string
  completed: RecordingPartial | null = null
  private readonly metadataPath: string
  private readonly locator: RecordingAssetLocator
  private readonly options: Readonly<NativeRecordingPartialOptions>

  constructor(
    private readonly root: string,
    locator: RecordingAssetLocator,
    options: NativeRecordingPartialOptions,
  ) {
    this.locator = Object.freeze({
      provider: locator.provider,
      account: locator.account,
      occurrenceId: locator.occurrenceId,
      assetId: locator.assetId,
    })
    this.options = Object.freeze({ ...options })
    if (
      typeof root !== "string" ||
      !root ||
      root.includes("\0") ||
      !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}-$/.test(options.prefix) ||
      typeof options.persistent !== "boolean" ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes <= 0 ||
      Object.values(this.locator).some((value) => typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value))
    )
      throw new CliError("validation_error", "invalid native recording partial options")
    const key = options.persistent
      ? createHash("sha256").update(partialIdentity(this.locator)).digest("hex")
      : randomUUID()
    this.path = join(root, `${options.prefix}${key}.part`)
    this.metadataPath = join(root, `${options.prefix}${key}.json`)
  }

  private scope(locator: RecordingAssetLocator) {
    if (partialIdentity(locator) !== partialIdentity(this.locator))
      throw new CliError("validation_error", "recording partial scope changed")
    this.options.signal?.throwIfAborted()
  }

  async load(locator: RecordingAssetLocator): Promise<RecordingPartial | null> {
    this.scope(locator)
    if (!this.options.persistent) return null
    const value = await readPartialMetadata(this.metadataPath, this.locator, this.options.maxBytes, this.options.signal)
    if (!value) return null
    const file = await openOrdinaryFile(this.path)
    try {
      const actual = await fingerprintPartial(file, this.options.signal, value.offset)
      if (actual.offset !== value.offset || actual.sha256 !== value.sha256)
        throw new CliError("validation_error", "recording partial checksum does not match")
      return value
    } finally {
      await file.close()
    }
  }

  async open(
    locator: RecordingAssetLocator,
    options: { resume?: RecordingPartial; validator: string | null; total: number | null },
  ): Promise<RecordingTransferWriter> {
    this.scope(locator)
    const resume = options.resume ? { ...options.resume, locator: { ...options.resume.locator } } : undefined
    const partial = {
      locator: this.locator,
      offset: 0,
      sha256: "",
      validator: options.validator ?? "",
      total: options.total,
    }
    if (
      resume &&
      (partialIdentity(resume.locator) !== partialIdentity(this.locator) ||
        !Number.isSafeInteger(resume.offset) ||
        resume.offset < 0 ||
        resume.offset > this.options.maxBytes)
    )
      throw new CliError("validation_error", "recording partial scope changed")
    this.completed = null
    let file: FileHandle
    if (resume) {
      file = await openOrdinaryFile(this.path, { writable: true })
    } else {
      const temp = join(this.root, `${this.options.prefix}${randomUUID()}.tmp`)
      file = await open(temp, "wx+", 0o600)
      try {
        await rename(temp, this.path)
        await unlink(this.metadataPath).catch((error) => {
          if (!missing(error)) throw error
        })
      } catch (error) {
        await file.close()
        await unlink(temp).catch(() => undefined)
        throw error
      }
    }
    try {
      const fingerprint = await fingerprintPartial(file, this.options.signal, resume?.offset)
      if (resume && (fingerprint.offset !== resume.offset || fingerprint.sha256 !== resume.sha256))
        throw new CliError("validation_error", "recording partial changed before append")
      if (resume && (await file.stat()).size > fingerprint.offset) await file.truncate(fingerprint.offset)
      return await partialWriter({
        file,
        path: this.path,
        root: this.root,
        metadataPath: this.metadataPath,
        prefix: this.options.prefix,
        persistent: this.options.persistent,
        maxBytes: this.options.maxBytes,
        signal: this.options.signal,
        partial,
        fingerprint,
        complete: (value) => {
          this.completed = value
        },
      })
    } catch (error) {
      await file.close()
      throw error
    }
  }
}
