import { mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { readAttachments, readUpload, refusedPlace, uploadBlob, uploadBytes } from "./upload.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }

const setUp = () => {
  const root = mkdtempSync(join(tmpdir(), "upload-"))
  const env = { CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "store", "m.db") }
  const put = (path: string) => {
    const full = join(root, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, "bytes")
    return full
  }
  return { root, env, put }
}

describe("readUpload", () => {
  it("protects the default WhatsApp folders from another CLI", () => {
    const platform = process.platform
    const { root, env } = setUp()
    const isolated = {
      ...env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state-home"),
      XDG_CACHE_HOME: join(root, "cache-home"),
      XDG_DATA_HOME: join(root, "data-home"),
      APPDATA: join(root, "roaming"),
      LOCALAPPDATA: join(root, "local"),
    }
    const paths = resolvePaths({ appName: "whatsapp-cli", prefix: "WA", env: isolated, platform })
    for (const directory of Object.values(paths))
      expect(refusedPlace(join(directory, "profiles", "synthetic", "private.db"), app, isolated, platform)).toBe(true)
    expect(refusedPlace(join(root, ".worktrees", "whatsapp-notes.txt"), app, isolated, platform)).toBe(false)
  })

  it("refuses overridden WhatsApp device state and links before making an upload, with the explicit override retained", async () => {
    const { root, env, put } = setUp()
    const state = join(root, "wa-state")
    const context = { app, env: { ...env, WA_STATE_DIR: state } }
    const device = put("wa-state/profiles/synthetic/private.db")
    const link = join(root, "ordinary.txt")
    symlinkSync(device, link)
    expect(refusedPlace(join(state, "profiles", "synthetic", "PRIVATE.DB"), app, context.env, "win32")).toBe(true)
    for (const path of [device, link])
      await expect(readUpload("file", path, context)).rejects.toThrow(/--allow-any-file/)
    expect(await readUpload("file", device, { ...context, anyFile: true })).toMatchObject({ name: "private.db" })
    expect(await readUpload("file", put("wa-state-notes/report.txt"), context)).toMatchObject({ name: "report.txt" })
  })

  it("reads a file with its name, and a photo only with a photo's extension", async () => {
    const { env, put } = setUp()

    expect(await readUpload("file", put("docs/plan.pdf"), { app, env })).toMatchObject({
      kind: "file",
      name: "plan.pdf",
    })
    expect((await readUpload("photo", put("pics/cat.JPG"), { app, env })).source).toMatchObject({
      kind: "file",
      size: 5,
    })
    await expect(readUpload("photo", put("pics/cat.gif"), { app, env })).rejects.toThrow(/send .* as a file/)
  })

  it("**refuses credential files, the CLI's own folders and the store**, also through a link — unless anyFile", async () => {
    const { root, env, put } = setUp()
    const key = put(".ssh/id_ed25519")
    const link = join(root, "innocent.txt")
    symlinkSync(key, link)

    for (const path of [key, put("state/session"), put("store/m.db"), put("store/m.db-wal"), link]) {
      await expect(readUpload("file", path, { app, env })).rejects.toThrow(/--allow-any-file/)
    }
    expect(await readUpload("file", key, { app, env, anyFile: true })).toMatchObject({ name: "id_ed25519" })
    expect(await readUpload("file", put("store/report.pdf"), { app, env })).toMatchObject({ name: "report.pdf" })
  })

  it("allows hidden developer folders and similarly named store neighbors", async () => {
    const { env, put } = setUp()
    for (const name of [
      ".worktrees/a.txt",
      ".cache/a.txt",
      ".incoming/.notes",
      "store/m.db-report.pdf",
      ".config/nvim/init.lua",
      ".docker/daemon.json",
      ".claude/settings.json",
      ".codex/config.toml",
      ".local/share/fonts/a.ttf",
    ])
      expect(await readUpload("file", put(name), { app, env })).toMatchObject({ kind: "file" })
  })

  it.each([
    ".netrc",
    "_netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".config/gh/hosts.yml",
    ".docker/config.json",
    ".kube/config",
    ".config/gcloud/credentials.db",
    ".aws/credentials",
    ".azure/msal_token_cache.json",
    ".claude/.credentials.json",
    ".codex/auth.json",
    ".npmrc",
    ".pypirc",
    ".password-store/mail.gpg",
    ".local/share/keyrings/login.keyring",
    "Library/Keychains/login.keychain-db",
    ".config/google-chrome/Default/Cookies",
    ".config/chromium/Default/Login Data",
    ".config/microsoft-edge/Default/Cookies",
    ".config/BraveSoftware/Brave-Browser/Default/Cookies",
    ".mozilla/firefox/abc.default/logins.json",
    "Library/Application Support/Google/Chrome/Default/Cookies",
    "Library/Application Support/Microsoft Edge/Default/Cookies",
    "Library/Application Support/Firefox/Profiles/abc/cookies.sqlite",
    "Library/Safari/History.db",
    "Library/Cookies/Cookies.binarycookies",
    "AppData/Local/Google/Chrome/User Data/Default/Cookies",
    "AppData/Local/Microsoft/Edge/User Data/Default/Cookies",
    "AppData/Roaming/Mozilla/Firefox/Profiles/abc/logins.json",
    "AppData/Roaming/Microsoft/Credentials/ABC",
    "AppData/Roaming/GitHub CLI/hosts.yml",
  ])("**refuses the known credential place** %s", async (name) => {
    const { env, put } = setUp()
    await expect(readUpload("file", put(name), { app, env })).rejects.toThrow(/--allow-any-file/)
  })

  it("**refuses every WireCat app's folders**, not only its own", () => {
    const { root, env } = setUp()
    const others = {
      ...env,
      TG_STATE_DIR: join(root, "tg"),
      MAX_CONFIG_DIR: join(root, "max"),
      MEMO_STATE_DIR: join(root, "memo"),
      DRIVE_CONFIG_DIR: join(root, "drive"),
      ZM_STATE_DIR: join(root, "zoom"),
    }
    for (const dir of ["tg", "max", "memo", "drive", "zoom"])
      expect(refusedPlace(join(root, dir, "session"), app, others)).toBe(true)
    expect(refusedPlace(join(root, "notes", "session"), app, others)).toBe(false)
  })

  it("**refuses the shared WireCat folder**, where the store's backups and the models are", () => {
    const { root, env } = setUp()
    const shared = { ...env, WIRECAT_STATE_DIR: join(root, "wirecat") }
    expect(refusedPlace(join(root, "wirecat", "wirecat.db.backup-2026-10-14"), app, shared)).toBe(true)
    expect(refusedPlace(join(root, "wirecat-notes", "a.txt"), app, shared)).toBe(false)
  })

  it("names the flag but no command in its refusal: bot uploads and `bot api` @path fields hit it too", async () => {
    const { env, put } = setUp()
    const refused = readUpload("file", put(".netrc"), { app, env })
    await expect(refused).rejects.toThrow(/--allow-any-file to the command/)
    await expect(refused).rejects.not.toThrow(/messages send/)
  })

  it("**compares names case-insensitively on macOS and Windows**, and exactly on Linux", () => {
    const { root, env } = setUp()
    for (const name of [".SSH/id_ed25519", ".Netrc", ".ENV", ".Config/GH/hosts.yml", "STATE/session"]) {
      expect(refusedPlace(join(root, name), app, env, "darwin")).toBe(true)
      expect(refusedPlace(join(root, name), app, env, "win32")).toBe(true)
    }
    expect(refusedPlace(join(root, "store", "M.DB"), app, env, "darwin")).toBe(true)
    expect(refusedPlace(join(root, ".SSH", "id_ed25519"), app, env, "linux")).toBe(false)
  })

  it("says what is wrong with a path that is not a readable file", async () => {
    const { root, env } = setUp()

    await expect(readUpload("file", join(root, "missing.pdf"), { app, env })).rejects.toThrow(/no such file/)
    await expect(readUpload("file", root, { app, env })).rejects.toThrow(/a folder/)
  })

  // Windows would write the 2 GiB out; elsewhere the file is sparse.
  it.skipIf(process.platform === "win32")(
    "checks a file of 2 GiB without reading it: it streams, and only a send from memory refuses it",
    async () => {
      const { env, put } = setUp()
      const huge = put("huge.bin")
      truncateSync(huge, 2 ** 31)

      const { source } = await readUpload("file", huge, { app, env })

      expect(source).toEqual({ kind: "file", path: huge, size: 2 ** 31 })
      expect((await uploadBlob(source)).size).toBe(2 ** 31)
      await expect(uploadBytes(source)).rejects.toThrow(/at most 256 MiB from memory — nothing was sent/)
    },
  )
})

describe("uploadBytes and uploadBlob", () => {
  it("read the file when it is sent, and refuse one that changed after it was checked", async () => {
    const { env, put } = setUp()
    const path = put("notes.txt")
    const { source } = await readUpload("file", path, { app, env })

    expect(new TextDecoder().decode(await uploadBytes(source))).toBe("bytes")
    writeFileSync(path, "longer bytes")
    await expect(uploadBytes(source)).rejects.toThrow(/changed after it was checked/)
    await expect(uploadBlob(source)).rejects.toThrow(/changed after it was checked/)
  })

  it("hand bytes made in memory over as they are", async () => {
    const bytes = new Uint8Array([1, 2, 3])

    expect(await uploadBytes({ kind: "bytes", bytes })).toBe(bytes)
    expect(new Uint8Array(await (await uploadBlob({ kind: "bytes", bytes })).arrayBuffer())).toEqual(bytes)
  })
})

describe("readAttachments", () => {
  it("gives the --file the --filename, and refuses one without a file or with a path in it", async () => {
    const { env, put } = setUp()
    const file = put("exports/a1b2c3.pdf")

    expect(await readAttachments({ file, filename: "Report Q3.pdf" }, { app, env })).toMatchObject([
      { kind: "file", name: "Report Q3.pdf" },
    ])
    await expect(readAttachments({ photo: put("cat.jpg"), filename: "x.jpg" }, { app, env })).rejects.toThrow(
      "--filename names a --file",
    )
    for (const filename of ["../x.pdf", "a\\b.pdf", " "]) {
      await expect(readAttachments({ file, filename }, { app, env })).rejects.toThrow("not a path")
    }
  })
})
