import { realpathSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { MIGRATIONS, migrate } from "../migrations.js"
import { applyTransfer } from "../sqlite/document-transfer/apply.js"
import { planTransfer } from "../sqlite/document-transfer/plan.js"
import { transferSnapshot } from "../sqlite/document-transfer/snapshot.js"
import { openSqlite } from "../sqlite/open.js"
import { openStoreContext } from "../sqlite/open-store.js"
import { assertReadCompatible } from "../sqlite/read-compatibility.js"
import { digest } from "./digest.js"
import type { DocumentTransferOptions } from "./model.js"

export type { DocumentTransferOptions, DocumentTransferPreview, DocumentTransferReceipt } from "./model.js"

const locations = (options: DocumentTransferOptions) => {
  for (const value of [options.source, options.destination, options.collection])
    if (typeof value !== "string" || !value.trim())
      throw new CliError("validation_error", "transfer source, destination and collection are required")
  if (!statSync(options.source, { throwIfNoEntry: false })?.isFile())
    throw new CliError("not_found", "the source store does not exist as a file")
  const source = realpathSync(options.source),
    destination = resolve(options.destination)
  const left = statSync(source),
    right = statSync(destination, { throwIfNoEntry: false })
  if (right && (!right.isFile() || (left.dev === right.dev && left.ino === right.ino)))
    throw new CliError("validation_error", "the source and destination must be different ordinary store files")
  const bindings = options.bindings ?? {}
  if (
    !bindings ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    Object.values(bindings).some((value) => typeof value !== "string" || !value.trim())
  )
    throw new CliError("validation_error", "transfer bindings must map source references to destination references")
  return { source, destination, sourceKey: digest([left.dev, left.ino, left.birthtimeMs]), bindings }
}

const openSource = async (path: string) => {
  const opened = await openSqlite(path, { readOnly: true })
  try {
    const row = opened.database
      .prepare("SELECT version,min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1")
      .get()
    const version = Number(row?.version),
      minimum = Number(row?.min_compatible)
    if (
      !Number.isSafeInteger(version) ||
      version < 2 ||
      version > (MIGRATIONS.at(-1)?.version ?? 0) ||
      !Number.isSafeInteger(minimum) ||
      minimum < 1 ||
      minimum > version ||
      minimum > (MIGRATIONS.at(-1)?.version ?? 0)
    )
      throw new CliError(
        "configuration_error",
        "the store schema is not compatible with document annotation transfer; upgrade a separate copy first",
      )
    return opened
  } catch (error) {
    opened.database.close()
    if (error instanceof CliError) throw error
    throw new CliError("configuration_error", "the store has no readable annotation schema; it was not changed")
  }
}

const openPreviewTarget = async (path: string) => {
  if (statSync(path, { throwIfNoEntry: false })) {
    const opened = await openSource(path)
    try {
      assertReadCompatible(opened.database)
      return opened
    } catch (error) {
      opened.database.close()
      throw error
    }
  }
  const target = await openSqlite(":memory:")
  try {
    migrate(target.database)
    return target
  } catch (error) {
    target.database.close()
    throw error
  }
}

export const previewDocumentTransfer = async (options: DocumentTransferOptions) => {
  const location = locations(options)
  const source = await openSource(location.source)
  try {
    const target = await openPreviewTarget(location.destination)
    try {
      return planTransfer(
        target.database,
        transferSnapshot(source.database, options.collection),
        location.sourceKey,
        location.bindings,
      ).preview
    } finally {
      target.database.close()
    }
  } finally {
    source.database.close()
  }
}

export const applyDocumentTransfer = async (options: DocumentTransferOptions & { expected_fingerprint: string }) => {
  if (!/^[a-f0-9]{64}$/.test(options.expected_fingerprint))
    throw new CliError("validation_error", "apply requires the fingerprint returned by a transfer preview")
  const location = locations(options)
  const source = await openSource(location.source)
  try {
    const snapshot = transferSnapshot(source.database, options.collection)
    const check = await openPreviewTarget(location.destination)
    try {
      const preview = planTransfer(check.database, snapshot, location.sourceKey, location.bindings).preview
      if (preview.fingerprint !== options.expected_fingerprint)
        throw new CliError("validation_error", "the transfer preview changed; preview it again before applying")
      if (!preview.ready)
        throw new CliError(
          "configuration_error",
          "the transfer has unresolved references or conflicts; preview it before applying",
        )
    } finally {
      check.database.close()
    }
    const target = await openStoreContext({ path: location.destination, env: options.env })
    try {
      const receipt = applyTransfer(
        target.database,
        snapshot,
        location.sourceKey,
        location.bindings,
        options.expected_fingerprint,
        target.now,
      )
      if (digest(transferSnapshot(source.database, options.collection)) !== digest(snapshot))
        throw new CliError(
          "configuration_error",
          "source annotations changed during the transfer; the source and copied snapshot were retained, keep the original store selected",
        )
      return receipt
    } finally {
      target.database.close()
    }
  } finally {
    source.database.close()
  }
}
