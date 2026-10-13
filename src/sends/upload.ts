import { realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { storePath } from "../store/path.js"
import type { ResourceLimits } from "./resource-limits.js"
import { type UploadSource, uploadBytes, validateUploadSizes, validateUploadSources } from "./upload-source.js"

export type UploadKind = "photo" | "file" | "voice"

/** A file read for sending. Its name goes to the messenger and never to the journal. */
export interface Upload {
  kind: UploadKind
  name: string
  bytes: Uint8Array
  /** A `file` that goes as a file to download even where the messenger would play it — a video. */
  asFile?: true
}

export interface FileUpload {
  kind: UploadKind
  name: string
  source: UploadSource
  asFile?: true
}
export type UploadInput = Upload | FileUpload
export const uploadSource = (upload: UploadInput): UploadSource =>
  "source" in upload ? upload.source : { kind: "bytes", bytes: upload.bytes }
export const validateUploads = (uploads: readonly UploadInput[], limits?: Partial<ResourceLimits>): void =>
  validateUploadSources(uploads.map(uploadSource), limits)

const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp"])
const VOICE = new Set([".ogg", ".oga", ".opus"])

/** Protect known credential/state paths without refusing ordinary hidden developer folders. */
export const refusedPlace = (path: string, app: AppIdentity, env: NodeJS.ProcessEnv): boolean => {
  const own = Object.values(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }))
  // The store file and its -wal and -shm, not its folder: MESSAGING_STORE may sit in the home folder.
  const store = resolve(storePath(env))
  let ancestor = resolve(path)
  let real = ancestor
  // Downloads may create missing descendants of a symlinked directory.
  for (;;) {
    try {
      real = resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
      break
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  const credentialFolders = new Set([".ssh", ".gnupg", ".aws", ".secrets", "secrets"])
  const credentialFiles = new Set([".env", ".npmrc", ".pypirc", "credentials.yml.enc", "master.key"])
  return [resolve(path), real].some(
    (candidate) =>
      candidate
        .split(sep)
        .some(
          (part, index, parts) =>
            credentialFolders.has(part) ||
            credentialFiles.has(part) ||
            /^\.env\./.test(part) ||
            (part === ".config" && parts[index + 1] === "autostart"),
        ) ||
      own.some((dir) => inside(candidate, dir)) ||
      [store, `${store}-wal`, `${store}-shm`].includes(candidate),
  )
}

const inside = (path: string, dir: string): boolean => {
  const way = relative(resolve(dir), path)
  return way === "" || (!way.startsWith("..") && !isAbsolute(way))
}

export const readUpload = async (
  kind: UploadKind,
  path: string,
  { app, env = process.env, anyFile = false, limits }: UploadReadOptions,
): Promise<Upload> => {
  validateUploadPath(kind, path, app, env, anyFile)
  try {
    const info = await stat(path)
    if (!info.isFile()) throw Object.assign(new Error("folder"), { code: "EISDIR" })
    validateUploadSizes([{ size: info.size, buffered: true }], limits)
    const upload = {
      kind,
      name: basename(path),
      bytes: await uploadBytes({ kind: "file", path, size: info.size }, limits),
    }
    validateUploads([upload], limits)
    return upload
  } catch (error) {
    if (error instanceof CliError) throw error
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : "it cannot be read"
    throw new CliError("validation_error", `cannot send ${path}: ${reason}`)
  }
}

/**
 * What a send attaches, as `messages send` and its tool take it. A voice message goes alone, as the
 * messengers' own apps send one.
 */
const checkFilename = (filename: string, file: string | undefined): void => {
  if (file === undefined) throw new CliError("validation_error", "--filename names a --file; give one")
  if (filename.trim() === "" || /[/\\\0]/.test(filename) || filename.length > 255)
    throw new CliError("validation_error", "--filename is a name, not a path: no / or \\, at most 255 characters")
}

type AttachmentFlags = {
  photo?: string
  file?: string
  voice?: string
  asFile?: boolean
  filename?: string
  text?: string
}
type UploadReadOptions = {
  app: AppIdentity
  env?: NodeJS.ProcessEnv
  anyFile?: boolean
  limits?: Partial<ResourceLimits>
}

export function readAttachments(
  flags: AttachmentFlags,
  read: UploadReadOptions & { fileBacked: true },
): Promise<UploadInput[]>
export function readAttachments(flags: AttachmentFlags, read: UploadReadOptions): Promise<Upload[]>
export async function readAttachments(
  { photo, file, voice, asFile, filename, text }: AttachmentFlags,
  read: UploadReadOptions & { fileBacked?: boolean },
): Promise<UploadInput[]> {
  if (voice !== undefined && (photo !== undefined || file !== undefined || (text ?? "").trim() !== "")) {
    throw new CliError("validation_error", "a voice message goes alone — no text, no file, no photo beside it")
  }
  if (asFile && file === undefined) throw new CliError("validation_error", "--as-file is about a --file; give one")
  if (filename !== undefined) checkFilename(filename, file)
  const prepare = readFileUpload
  const uploads = [
    ...(photo === undefined ? [] : [await prepare("photo", photo, read)]),
    ...(file === undefined
      ? []
      : [
          {
            ...(await prepare("file", file, read)),
            ...(filename === undefined ? {} : { name: filename }),
            ...(asFile ? { asFile: true as const } : {}),
          },
        ]),
    ...(voice === undefined ? [] : [await prepare("voice", voice, read)]),
  ]
  validateUploads(uploads, read.limits)
  if (read.fileBacked) return uploads
  validateUploadSizes(
    uploads.map((upload) => ({
      size: upload.source.kind === "file" ? upload.source.size : upload.source.bytes.byteLength,
      buffered: true,
    })),
    read.limits,
  )
  const buffered: Upload[] = []
  for (const { source, ...upload } of uploads)
    buffered.push({ ...upload, bytes: await uploadBytes(source, read.limits) })
  return buffered
}

export const readFileUpload = async (
  kind: UploadKind,
  path: string,
  { app, env = process.env, anyFile = false, limits }: UploadReadOptions,
): Promise<FileUpload> => {
  validateUploadPath(kind, path, app, env, anyFile)
  try {
    const info = await stat(path)
    if (!info.isFile()) throw Object.assign(new Error("folder"), { code: "EISDIR" })
    const upload: FileUpload = {
      kind,
      name: basename(path),
      source: { kind: "file", path: resolve(path), size: info.size },
    }
    validateUploads([upload], limits)
    return upload
  } catch (error) {
    if (error instanceof CliError) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new CliError(
      "validation_error",
      `cannot send ${path}: ${code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : "it cannot be read"}`,
    )
  }
}

const validateUploadPath = (
  kind: UploadKind,
  path: string,
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  anyFile: boolean,
): void => {
  if (kind === "photo" && !PHOTO.has(extname(path).toLowerCase())) {
    throw new CliError("validation_error", `a photo is a .jpg, .png or .webp — send ${path} as a file instead`)
  }
  if (kind === "voice" && !VOICE.has(extname(path).toLowerCase())) {
    throw new CliError("validation_error", `a voice message is Ogg Opus: .ogg, .oga or .opus — send ${path} as a file`)
  }
  if (!anyFile && refusedPlace(path, app, env)) {
    throw new CliError(
      "validation_error",
      `cannot send ${path}: known credential files, ${app.command}'s own folders and the message store ` +
        `are not sent — the owner adds --allow-any-file to \`${app.command} messages send\` if this file is meant to go`,
    )
  }
}
