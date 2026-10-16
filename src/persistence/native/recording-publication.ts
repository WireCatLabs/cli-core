import { createHash } from "node:crypto"
import { link } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { RecordingAssetLocator, RecordingPartial } from "../../meetings/index.js"
import { strongRecordingValidator } from "../../meetings/index.js"
import { partialIdentity } from "./recording-partial-metadata.js"
import {
  assertPublicationIdentity,
  commitPublication,
  type RecordingPublicationFingerprint,
  verifiedPublicationFile,
} from "./recording-publication-files.js"
import {
  type RecordingPublicationCodec,
  readPublicationJournal,
  writePublicationJournal,
} from "./recording-publication-journal.js"

export interface NativeRecordingPublicationOptions<T> {
  prefix: string
  filename: string
  maxBytes: number
  metadataLimit: number
  codec: RecordingPublicationCodec<T>
  evidence(value: T): RecordingPublicationFingerprint & { validator: string }
  signal?: AbortSignal
}

/** The host holds one root writer lease and durably commits its manifest in the callback. */
export class NativeRecordingPublication<T> {
  readonly journalPath: string
  readonly finalPath: string
  private readonly scope: string
  private readonly options: Readonly<NativeRecordingPublicationOptions<T>>

  constructor(
    private readonly root: string,
    locator: RecordingAssetLocator,
    options: NativeRecordingPublicationOptions<T>,
  ) {
    if (
      !root ||
      root.includes("\0") ||
      !/^\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}-$/.test(options.prefix) ||
      !options.filename ||
      basename(options.filename) !== options.filename ||
      /[\\/\0]/.test(options.filename) ||
      [".", ".."].includes(options.filename) ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes <= 0 ||
      !Number.isSafeInteger(options.metadataLimit) ||
      options.metadataLimit <= 0 ||
      options.metadataLimit > 1048576 ||
      [locator.provider, locator.account, locator.occurrenceId, locator.assetId].some(
        (value) => typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value),
      )
    )
      throw new CliError("validation_error", "invalid native recording publication options")
    this.scope = partialIdentity(locator)
    this.options = Object.freeze({ ...options, codec: Object.freeze({ ...options.codec }) })
    this.journalPath = join(root, `${options.prefix}${createHash("sha256").update(this.scope).digest("hex")}.json`)
    this.finalPath = join(root, options.filename)
    if (this.finalPath === this.journalPath)
      throw new CliError("validation_error", "recording publication paths must be distinct")
  }

  read(): Promise<T | null> {
    return readPublicationJournal(this.journalPath, this.options.codec, this.options.metadataLimit, this.options.signal)
  }

  write(value: T): Promise<void> {
    return writePublicationJournal(
      this.root,
      this.journalPath,
      this.options.prefix,
      value,
      this.options.codec,
      this.options.metadataLimit,
      this.options.signal,
    )
  }

  private validate(partialPath: string, expected: RecordingPublicationFingerprint) {
    if (
      resolve(dirname(partialPath)) !== resolve(this.root) ||
      resolve(partialPath) === resolve(this.finalPath) ||
      resolve(partialPath) === resolve(this.journalPath) ||
      !Number.isSafeInteger(expected.size) ||
      expected.size < 0 ||
      expected.size > this.options.maxBytes ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)
    )
      throw new CliError("validation_error", "invalid recording publication evidence")
    this.options.signal?.throwIfAborted()
  }

  async publish(
    partialPath: string,
    expected: RecordingPublicationFingerprint,
    commit: () => Promise<void>,
  ): Promise<void> {
    const proof = { ...expected }
    this.validate(partialPath, proof)
    const partial = await verifiedPublicationFile(partialPath, proof, this.options.signal, true)
    try {
      await partial.sync()
      this.options.signal?.throwIfAborted()
      await assertPublicationIdentity(partialPath, partial)
      await link(partialPath, this.finalPath)
      await assertPublicationIdentity(this.finalPath, partial)
      await commitPublication(this.root, partialPath, this.finalPath, partial, partial, commit, this.options.signal)
    } finally {
      await partial.close()
    }
  }

  async recover(
    partialPath: string,
    loadPartial: () => Promise<RecordingPartial | null>,
    commit: (value: T) => Promise<void>,
  ): Promise<T> {
    const intent = await this.read()
    if (intent === null)
      throw new CliError(
        "validation_error",
        "recording path already exists without a verified manifest or scoped recovery record",
      )
    const expected = { ...this.options.evidence(intent) }
    this.validate(partialPath, expected)
    const completed = await loadPartial()
    if (
      !strongRecordingValidator(expected.validator) ||
      !completed ||
      partialIdentity(completed.locator) !== this.scope ||
      completed.offset !== expected.size ||
      completed.sha256 !== expected.sha256 ||
      completed.validator !== expected.validator ||
      (completed.total !== null && completed.total !== expected.size)
    )
      throw new CliError("validation_error", "recording recovery checkpoint does not prove this completed asset")
    const partial = await verifiedPublicationFile(partialPath, expected, this.options.signal)
    try {
      const final = await verifiedPublicationFile(this.finalPath, expected, this.options.signal, true)
      try {
        await final.sync()
        this.options.signal?.throwIfAborted()
        await commitPublication(
          this.root,
          partialPath,
          this.finalPath,
          partial,
          final,
          () => commit(intent),
          this.options.signal,
        )
        return intent
      } finally {
        await final.close()
      }
    } finally {
      await partial.close()
    }
  }
}
