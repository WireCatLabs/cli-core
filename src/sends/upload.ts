import { openAsBlob, realpathSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"
import type { Upload, UploadKind, UploadSource } from "../domain/attachments.js"
import type { AppIdentity } from "../ports/app.js"
import { storePath, wirecatDirectory } from "../store/path.js"

/** The most `uploadBytes` holds in memory; an adapter that can stream uses `uploadBlob` and has no such cap. */
export const MAX_BUFFERED_UPLOAD_BYTES = 256 * 1024 * 1024

export const uploadSize = (source: UploadSource): number =>
  source.kind === "file" ? source.size : source.bytes.byteLength

const changed = () => new CliError("validation_error", "the file changed after it was checked — nothing was sent")

/** The upload as a Blob that reads the file as it is sent. */
export const uploadBlob = async (source: UploadSource, type?: string): Promise<Blob> => {
  if (source.kind === "bytes") return new Blob([source.bytes], type === undefined ? {} : { type })
  const blob = await openAsBlob(source.path, type === undefined ? {} : { type })
  if (blob.size !== source.size) throw changed()
  return blob
}

/** The upload's bytes in memory, for a messenger library that takes nothing else. */
export const uploadBytes = async (source: UploadSource): Promise<Uint8Array> => {
  if (source.kind === "bytes") return source.bytes
  if (source.size > MAX_BUFFERED_UPLOAD_BYTES)
    throw new CliError(
      "validation_error",
      `the file is ${Math.ceil(source.size / 1024 / 1024)} MiB, and this messenger sends at most ` +
        `${MAX_BUFFERED_UPLOAD_BYTES / 1024 / 1024} MiB from memory — nothing was sent`,
    )
  const bytes = new Uint8Array(await (await uploadBlob(source)).arrayBuffer())
  if (bytes.byteLength !== source.size) throw changed()
  return bytes
}

const PHOTO = new Set([".jpg", ".jpeg", ".png", ".webp"])
const VOICE = new Set([".ogg", ".oga", ".opus"])

/** `[".jpg", ".jpeg"]` as help says it: ".jpg or .jpeg". */
export const typesText = (types: readonly string[]): string =>
  types.length < 2 ? (types[0] ?? "") : `${types.slice(0, -1).join(", ")} or ${types.at(-1)}`

/** Single path parts that hold credentials wherever they are. */
const CREDENTIAL_PARTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".secrets",
  "secrets",
  ".password-store",
  ".mozilla",
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  "credentials.yml.enc",
  "master.key",
])

/** Runs of path parts, matched anywhere in the path: tokens, keyrings, browser profiles with their cookies. */
const CREDENTIAL_RUNS: readonly (readonly string[])[] = [
  [".config", "autostart"],
  [".config", "git", "credentials"],
  [".config", "gh"],
  [".config", "gcloud"],
  [".config", "google-chrome"],
  [".config", "chromium"],
  [".config", "microsoft-edge"],
  [".config", "BraveSoftware"],
  [".docker", "config.json"],
  [".claude", ".credentials.json"],
  [".codex", "auth.json"],
  [".local", "share", "keyrings"],
  ["Library", "Keychains"],
  ["Library", "Cookies"],
  ["Library", "Safari"],
  ["Library", "Application Support", "Google", "Chrome"],
  ["Library", "Application Support", "Chromium"],
  ["Library", "Application Support", "Microsoft Edge"],
  ["Library", "Application Support", "BraveSoftware"],
  ["Library", "Application Support", "Firefox"],
  ["AppData", "Local", "Google", "Chrome"],
  ["AppData", "Local", "Chromium"],
  ["AppData", "Local", "Microsoft", "Edge"],
  ["AppData", "Local", "BraveSoftware"],
  ["AppData", "Roaming", "Mozilla", "Firefox"],
  ["AppData", "Local", "Microsoft", "Credentials"],
  ["AppData", "Roaming", "Microsoft", "Credentials"],
  ["AppData", "Roaming", "Microsoft", "Protect"],
  ["AppData", "Roaming", "gcloud"],
  ["AppData", "Roaming", "GitHub CLI"],
]

/** Every WireCat app's folders hold its sessions and tokens; `max` must not send `tg`'s, nor the other way round. */
const WIRECAT_APPS: readonly { appName: string; prefix: string }[] = [
  { appName: "max-cli", prefix: "MAX" },
  { appName: "tg-cli", prefix: "TG" },
  { appName: "whatsapp-cli", prefix: "WA" },
  { appName: "cli-memo", prefix: "MEMO" },
  { appName: "drive-cli", prefix: "DRIVE" },
  { appName: "zm", prefix: "ZM" },
  { appName: "cli-messaging", prefix: "MESSAGING" },
  { appName: "cli-common", prefix: "CLI_COMMON" },
]

/** Protect known credential/state paths without refusing ordinary hidden developer folders. */
export const refusedPlace = (
  path: string,
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const own = [
    ...[{ appName: app.appName, prefix: app.envPrefix }, ...WIRECAT_APPS].flatMap((one) =>
      Object.values(resolvePaths({ ...one, env, platform })),
    ),
    // The shared WireCat folder: the store, its backups beside it, the models.
    wirecatDirectory(env, platform),
  ]
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
  // macOS and Windows find `~/.SSH` at `~/.ssh`, so the names are compared the way their file systems do.
  const folded = platform === "darwin" || platform === "win32"
  const fold = (text: string) => (folded ? text.toLowerCase() : text)
  const parts = new Set([...CREDENTIAL_PARTS].map(fold))
  const runs = CREDENTIAL_RUNS.map((run) => run.map(fold))
  const named = (candidate: string) => {
    const names = candidate.split(sep).map(fold)
    return names.some(
      (name, index) =>
        parts.has(name) ||
        /^\.env\./.test(name) ||
        runs.some((run) => run.every((part, offset) => names[index + offset] === part)),
    )
  }
  const same = (a: string, b: string) => fold(a) === fold(b)
  return [resolve(path), real].some(
    (candidate) =>
      named(candidate) ||
      own.some((dir) => inside(fold(candidate), fold(dir))) ||
      [store, `${store}-wal`, `${store}-shm`].some((file) => same(candidate, file)),
  )
}

const inside = (path: string, dir: string): boolean => {
  const way = relative(resolve(dir), path)
  return way === "" || (!way.startsWith("..") && !isAbsolute(way))
}

export const readUpload = async (
  kind: UploadKind,
  path: string,
  {
    app,
    env = process.env,
    anyFile = false,
    photoTypes,
  }: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean; photoTypes?: readonly string[] },
): Promise<Upload> => {
  const extension = extname(path).toLowerCase()
  if (kind === "photo" && photoTypes !== undefined && !photoTypes.includes(extension)) {
    throw new CliError("validation_error", `this photo must be a ${typesText(photoTypes)} file, not ${path}`)
  }
  if (kind === "photo" && photoTypes === undefined && !PHOTO.has(extension)) {
    throw new CliError("validation_error", `a photo is a .jpg, .png or .webp — send ${path} as a file instead`)
  }
  if (kind === "voice" && !VOICE.has(extension)) {
    throw new CliError("validation_error", `a voice message is Ogg Opus: .ogg, .oga or .opus — send ${path} as a file`)
  }
  if (kind === "sticker" && extname(path).toLowerCase() !== ".webp") {
    throw new CliError("validation_error", `a sticker is a .webp — send ${path} as a photo or a file instead`)
  }
  if (!anyFile && refusedPlace(path, app, env)) {
    throw new CliError(
      "validation_error",
      `cannot send ${path}: known credential files, browser profiles, the WireCat apps' folders and the message ` +
        "store are not sent — the owner adds --allow-any-file to the command if this file is meant to go",
    )
  }
  try {
    const info = await stat(path)
    if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" })
    return { kind, name: basename(path), source: { kind: "file", path: resolve(path), size: info.size } }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a folder" : "it cannot be read"
    throw new CliError("validation_error", `cannot send ${path}: ${reason}`)
  }
}

const checkFilename = (filename: string, file: string | undefined): void => {
  if (file === undefined) throw new CliError("validation_error", "--filename names a --file; give one")
  if (filename.trim() === "" || /[/\\\0]/.test(filename) || filename.length > 255)
    throw new CliError("validation_error", "--filename is a name, not a path: no / or \\, at most 255 characters")
}

/**
 * What a send attaches, as `messages send` and its tool take it. A voice message and a sticker go alone, as the
 * messengers' own apps send them; `stickerBytes` is the largest sticker the messenger takes.
 */
export const readAttachments = async (
  {
    photo,
    file,
    voice,
    sticker,
    asFile,
    filename,
    text,
  }: {
    photo?: string
    file?: string
    voice?: string
    sticker?: string
    asFile?: boolean
    filename?: string
    text?: string
  },
  read: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean; stickerBytes?: number },
): Promise<Upload[]> => {
  if (voice !== undefined && (photo !== undefined || file !== undefined || (text ?? "").trim() !== "")) {
    throw new CliError("validation_error", "a voice message goes alone — no text, no file, no photo beside it")
  }
  if (
    sticker !== undefined &&
    (photo !== undefined || file !== undefined || voice !== undefined || (text ?? "").trim() !== "")
  ) {
    throw new CliError("validation_error", "a sticker goes alone — no text, no file, no photo")
  }
  if (asFile && file === undefined) throw new CliError("validation_error", "--as-file is about a --file; give one")
  if (filename !== undefined) checkFilename(filename, file)
  return [
    ...(photo === undefined ? [] : [await readUpload("photo", photo, read)]),
    ...(file === undefined
      ? []
      : [
          {
            ...(await readUpload("file", file, read)),
            ...(filename === undefined ? {} : { name: filename }),
            ...(asFile ? { asFile: true as const } : {}),
          },
        ]),
    ...(voice === undefined ? [] : [await readUpload("voice", voice, read)]),
    ...(sticker === undefined ? [] : [await readSticker(sticker, read)]),
  ]
}

const readSticker = async (
  path: string,
  read: { app: AppIdentity; env?: NodeJS.ProcessEnv; anyFile?: boolean; stickerBytes?: number },
): Promise<Upload> => {
  if (read.stickerBytes === undefined) throw new CliError("validation_error", "this messenger sends no sticker files")
  const upload = await readUpload("sticker", path, read)
  if (!(await isWebp(path)))
    throw new CliError("validation_error", `${path} is named .webp but is not a WebP image — nothing was sent`)
  const size = uploadSize(upload.source)
  if (size > read.stickerBytes)
    throw new CliError(
      "validation_error",
      `the sticker is ${Math.ceil(size / 1024)} KiB, and this messenger takes at most ` +
        `${Math.floor(read.stickerBytes / 1024)} KiB — nothing was sent`,
    )
  return upload
}

const isWebp = async (path: string): Promise<boolean> => {
  const handle = await open(path, "r")
  try {
    const head = Buffer.alloc(12)
    const { bytesRead } = await handle.read(head, 0, 12, 0)
    return bytesRead === 12 && head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"
  } finally {
    await handle.close()
  }
}
