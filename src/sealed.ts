import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { type Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { CliError } from "@wirecat/cli-base"

/**
 * A file compressed and then encrypted with a password, by Node alone — no outside tool, no
 * dependency (owner's ruling `NEED-567`). The password is never kept: losing it loses the file.
 *
 * Layout: `MAGIC`, scrypt's cost as log2 N, r and p (one byte each), a 16-byte salt and a 12-byte
 * nonce; then the gzip stream under AES-256-GCM, the header bound to it as associated data; then
 * GCM's 16-byte tag, which makes a wrong password or a changed byte fail instead of yielding garbage.
 */
const MAGIC = Buffer.from("CMSEAL01")
const SALT = 16
const NONCE = 12
const TAG = 16
const HEADER = MAGIC.length + 3 + SALT + NONCE

export interface Cost {
  log2N: number
  r: number
  p: number
}

/** About half a second and 128 MB on a laptop: slow enough to make guessing a short password costly. */
export const COST: Cost = { log2N: 17, r: 8, p: 1 }

const keyOf = (password: string, salt: Buffer, { log2N, r, p }: Cost): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 2 ** log2N, r, p, maxmem: 2 * 128 * r * 2 ** log2N }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  )

/** What a folder of sealed files keeps to tell, before reading anything, whether a password is the one it was sealed with. */
export interface PasswordCheck {
  salt: string
  log2N: number
  r: number
  p: number
  /** SHA-256 of the key scrypt derives from the password and this salt — no file uses that key. */
  hash: string
}

/**
 * A check for this password. Guessing against it costs the same scrypt work as guessing against
 * any sealed file, so it makes no password easier to find.
 */
export const checkFor = async (password: string, cost: Cost = COST): Promise<PasswordCheck> => {
  refuseEmpty(password)
  const salt = randomBytes(SALT)
  const hash = createHash("sha256")
    .update(await keyOf(password, salt, cost))
    .digest("hex")
  return { salt: salt.toString("hex"), ...cost, hash }
}

export const passes = async (password: string, check: PasswordCheck): Promise<boolean> => {
  refuseCost(check)
  const key = await keyOf(password, Buffer.from(check.salt, "hex"), check)
  return timingSafeEqual(createHash("sha256").update(key).digest(), Buffer.from(check.hash, "hex"))
}

/** A damaged header must not make us reserve a gigabyte or more before the tag can say it is damaged. */
const refuseCost = ({ log2N, r, p }: Cost) => {
  if (log2N > 20 || r > 8 || p > 4)
    throw new CliError("validation_error", "asks for a key cost this version does not accept")
}

const refuseEmpty = (password: string) => {
  if (password.length === 0) throw new CliError("validation_error", "the password is empty")
}

/** Whether the file starts as a sealed file does. */
export const isSealed = (path: string): boolean => {
  const fd = openSync(path, "r")
  try {
    const start = Buffer.alloc(MAGIC.length)
    return readSync(fd, start, 0, MAGIC.length, 0) === MAGIC.length && start.equals(MAGIC)
  } finally {
    closeSync(fd)
  }
}

/** Seals `from` into `to`, a new file readable only by its owner; never overwrites. */
export const sealFile = (from: string, to: string, password: string, cost: Cost = COST): Promise<void> =>
  seal(() => createReadStream(from), to, password, cost)

/**
 * Seals what `open` yields into `to`, so what is sealed never lands on disk in the clear. Opened
 * only once the password is accepted: a stream opened and then refused would be left dangling.
 */
export const seal = async (open: () => Readable, to: string, password: string, cost: Cost = COST): Promise<void> => {
  refuseEmpty(password)
  const salt = randomBytes(SALT)
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv("aes-256-gcm", await keyOf(password, salt, cost), nonce)
  const header = Buffer.concat([MAGIC, Buffer.from([cost.log2N, cost.r, cost.p]), salt, nonce])
  cipher.setAAD(header)
  const out = createWriteStream(to, { flags: "wx", mode: 0o600 })
  out.write(header)
  const tagged = new Transform({
    transform: (chunk, _encoding, done) => done(null, cipher.update(chunk)),
    flush: (done) => {
      const last = cipher.final()
      done(null, Buffer.concat([last, cipher.getAuthTag()]))
    },
  })
  try {
    await pipeline(open(), createGzip(), tagged, out)
  } catch (error) {
    // `wx` means a file that was there is not ours to remove; one this call created and did not finish is.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") rmSync(to, { force: true })
    throw error
  }
}

/**
 * Opens `from` into `to`, a new file readable only by its owner. The plain text goes to a file
 * beside `to` first and takes its name only once the tag checks out, so a wrong password or a
 * damaged file leaves nothing half-written behind.
 */
export const unsealFile = async (from: string, to: string, password: string): Promise<void> => {
  refuseEmpty(password)
  const size = statSync(from).size
  if (size < HEADER + TAG || !isSealed(from)) {
    throw new CliError("validation_error", `${from} is not a sealed file`)
  }
  const fd = openSync(from, "r")
  const header = Buffer.alloc(HEADER)
  const tag = Buffer.alloc(TAG)
  try {
    readSync(fd, header, 0, HEADER, 0)
    readSync(fd, tag, 0, TAG, size - TAG)
  } finally {
    closeSync(fd)
  }
  const at = MAGIC.length
  const cost = { log2N: header[at] as number, r: header[at + 1] as number, p: header[at + 2] as number }
  refuseCost(cost)
  if (existsSync(to)) throw new CliError("validation_error", `${to} exists — never overwritten`)
  const salt = header.subarray(at + 3, at + 3 + SALT)
  const nonce = header.subarray(at + 3 + SALT, HEADER)
  const decipher = createDecipheriv("aes-256-gcm", await keyOf(password, salt, cost), nonce)
  decipher.setAuthTag(tag)
  decipher.setAAD(header)

  const pending = `${to}.partial`
  try {
    await pipeline(
      createReadStream(from, { start: HEADER, end: size - TAG - 1 }),
      decipher,
      createGunzip(),
      createWriteStream(pending, { flags: "wx", mode: 0o600 }),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error
    rmSync(pending, { force: true })
    // A wrong key yields noise, which gzip usually refuses before GCM gets to check the tag.
    const { code, message } = error as NodeJS.ErrnoException
    if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || message.includes("unable to authenticate")) {
      throw new CliError("validation_error", "wrong password, or the file was changed — nothing was written")
    }
    throw error
  }
  renameSync(pending, to)
}
