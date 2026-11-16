import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isCliError } from "@wirecat/cli-base"
import type { ContractCase } from "../../meetings/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { openStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import { downloadCrmFile } from "../cli/files.js"
import type { CrmRun } from "../cli/index.js"
import { parseCrmFileId } from "../files.js"
import { DAILY_FOREIGN_CONTACTS, foreignContacts } from "../foreign-contacts.js"
import { CRM_FILE_SOURCES, type CrmFileOwner, type CrmSource } from "../source.js"

/** One adapter with `files`, over recorded or faked responses, fresh for each case. */
export interface CrmFilesFixture {
  source: CrmSource
  /** A record of the sign-in's own with at least one file whose text holds `word`. */
  own: CrmFileOwner
  word: string
  /** A colleague's record with a file; needed when the source has `isAdmin`. */
  foreign?: CrmFileOwner
  /** What every file link the fixture serves carries, such as its token: it must reach no answer, file or error. */
  token: string
  /** Ids of files whose download the adapter must refuse: a link to another host, a web page instead of the file. */
  refused?: readonly string[]
}

const APP: AppIdentity = {
  command: "crm",
  appName: "crm-files-contract",
  envPrefix: "CRMFILES",
  description: "contract",
  version: "0.0.0",
}
const ACCOUNT: AccountKey = { provider: "contract-crm", account: "portal" }

const without = (token: string, what: string, value: unknown) =>
  assert.ok(
    !JSON.stringify(value ?? null).includes(token) && !String((value as Error)?.message ?? "").includes(token),
    `${what} holds the file link's token`,
  )

const filesOf = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
    : []

/** A store and a state folder of their own, and a run over the fixture's source. */
const runOver = async (source: CrmSource) => {
  const home = mkdtempSync(join(tmpdir(), "crm-files-contract-"))
  const path = join(home, "store.db")
  const store = await openStore({ path })
  const user = source.self ? String(await source.self()) : null
  const run: CrmRun = {
    profile: "contract",
    user,
    account: ACCOUNT,
    store,
    source: () => source,
    env: { HOME: home, XDG_STATE_HOME: home, CRMFILES_STATE_DIR: join(home, "state") },
  }
  return { run, store, path, state: join(home, "state"), context: { app: APP, run, now: () => Date.now() } }
}

/** What every CRM adapter's `files` answers, whatever the CRM: run each case in the adapter's tests. */
export const crmFilesContract = (make: () => CrmFilesFixture | Promise<CrmFilesFixture>): ContractCase[] => [
  {
    name: "files: one record's files, each with an id naming that record, a known source and no link anywhere",
    async run() {
      const { source, own, token } = await make()
      assert.ok(source.files, "the source has files")
      const found = await source.files(own)
      assert.ok(found && found.files.length > 0, "the own record lists a file")
      for (const file of found.files) {
        const { owner, source: kind } = parseCrmFileId(file.id)
        assert.deepEqual(owner, own, `${file.id} names its record`)
        assert.equal(kind, file.source)
        assert.ok((CRM_FILE_SOURCES as readonly string[]).includes(file.source))
        assert.ok(file.name.length > 0, "a file has a name")
        assert.ok(file.size === null || file.size >= 0)
        const { open: _open, ...listed } = file
        without(token, `the listed ${file.id}`, { id: listed.id, name: listed.name, owner: listed.owner })
      }
      assert.equal(await source.files({ kind: own.kind, id: "999999999" }), null, "a record the CRM lacks is null")
    },
  },
  {
    name: "files: a download is saved 600 in 700 folders, its text stored and found, and its token kept nowhere",
    async run() {
      const { source, own, word, token, refused = [] } = await make()
      const { run, store, path, state, context } = await runOver(source)
      try {
        const found = await source.files?.(own)
        assert.ok(found)
        const rows = []
        for (const file of found.files.filter((one) => !refused.includes(one.id)))
          rows.push(
            await downloadCrmFile(context, file, found.assignee, {
              capBytes: 100 * 1024 * 1024,
              capMb: 100,
              flag: false,
              limits: await store.crmFiles.limits(ACCOUNT),
            }),
          )
        assert.ok(
          rows.some((one) => one.row.text?.toLowerCase().includes(word.toLowerCase())),
          `a file's text holds ${word}`,
        )
        for (const saved of filesOf(state)) {
          assert.equal(statSync(saved).mode & 0o777, 0o600, `${saved} is the OS user's alone`)
          without(token, saved, readFileSync(saved, "latin1"))
        }
        assert.equal(statSync(join(state, "crm", "files")).mode & 0o777, 0o700)
        const hits = await store.crmFiles.find({ words: [word] })
        assert.ok(hits.items.length > 0, "search finds the text")
        if (found.assignee !== null && run.user !== null) {
          const other = { account: ACCOUNT, assignee: `${ACCOUNT.account}/user/0` }
          assert.equal((await store.crmFiles.find({ words: [word], viewers: [other] })).items.length, 0)
        }
        await store.close()
        assert.ok(!readFileSync(path, "latin1").includes(token), "the store file holds the token")
      } finally {
        await store.close().catch(() => {})
      }
    },
  },
  {
    name: "files: a refused link (another host, a web page) fails without its token and leaves no part",
    async run() {
      const { source, token, refused = [] } = await make()
      if (!refused.length) return
      const { store, state, context } = await runOver(source)
      try {
        for (const id of refused) {
          const { owner } = parseCrmFileId(id)
          const found = await source.files?.(owner)
          const file = found?.files.find((one) => one.id === id)
          assert.ok(file, `${id} is listed for ${owner.kind} ${owner.id}`)
          const error = await downloadCrmFile(context, file, found?.assignee ?? null, {
            capBytes: 1024 * 1024,
            capMb: 1,
            flag: false,
            limits: await store.crmFiles.limits(ACCOUNT),
          }).then(
            () => undefined,
            (caught: unknown) => caught,
          )
          assert.ok(isCliError(error), `${id} is refused`)
          without(token, `the refusal of ${id}`, error)
        }
        assert.deepEqual(filesOf(state), [], "a refused download keeps no file")
      } finally {
        await store.close()
      }
    },
  },
  {
    name: "files: a colleague's record costs one of the day's slots, and the 101st is refused",
    async run() {
      const { source, foreign } = await make()
      if (!source.isAdmin || !foreign || (await source.isAdmin())) return
      const found = await source.files?.(foreign)
      assert.ok(found, "the colleague's record lists its files")
      const file = join(mkdtempSync(join(tmpdir(), "crm-files-quota-")), "count.json")
      const day = new Date().toISOString().slice(0, 10)
      writeFileSync(
        file,
        JSON.stringify({ day, seen: Array.from({ length: DAILY_FOREIGN_CONTACTS }, (_, at) => `x:${at}`) }),
      )
      await assert.rejects(
        foreignContacts(source, () => file).spend(foreign.kind, { externalId: foreign.id, assignee: found.assignee }),
        (error: unknown) => isCliError(error) && error.details.reason === "crm.foreign-contacts-spent",
      )
    },
  },
]
