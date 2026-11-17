import assert from "node:assert/strict"
import { isCliError } from "@wirecat/cli-base"
import { ANSWER_RESERVE_MS, type Deadline, type RunBudget, runBudget } from "../../../background/budget.js"
import type { DocumentSource, SourceFile, SyncResult } from "../../../documents.js"
import type { ContractCase } from "../../../meetings/index.js"
import { DEFAULT_AGENT_COOPERATIVE_MS } from "../../execution.js"

/** What one sync of a fault case may be given: the CLI passes each on to `syncDocuments`. */
export interface DocumentFaultRun<M extends SourceFile = SourceFile> {
  /** Wraps the source the CLI builds for this run: the case counts its calls, slows them or cuts them off. */
  wrap(source: DocumentSource<M>): DocumentSource<M>
  budget?: RunBudget
  deadline?: Deadline
  signal?: AbortSignal
  now?(): number
}

/** Faults a case injects; each is opt-in, and a case whose hook is absent passes without running. */
export interface DocumentSourceFaults<M extends SourceFile = SourceFile> {
  /**
   * Makes one document below the root answer HTTP `status` from now on, as the provider would, and names it. It stays
   * listed in its folder, and the fixture holds at least one other document that still answers.
   */
  deny?(status: 403 | 404): string | Promise<string>
  /** A source over the same provider whose own clock runs `ms` ahead of the provider's, behind when negative. */
  skewed?(ms: number): DocumentSource<M> | Promise<DocumentSource<M>>
  /** A source for a second profile signed in with the same token. */
  sameToken?(): DocumentSource<M> | Promise<DocumentSource<M>>
  /**
   * The CLI's own sync of the root over this fixture's provider, its state and index kept between calls, and the ids
   * it holds after the call, all calls together. Given, the cases also check a sync: a fault skipped, an interrupted run resumed, the
   * MCP deadline kept.
   */
  sync?(run: DocumentFaultRun<M>): Promise<{ result: SyncResult; saved: readonly string[] }>
}

/** One adapter over recorded or faked responses, fresh for each case. */
export interface DocumentSourceFixture<M extends SourceFile = SourceFile> {
  source: DocumentSource<M>
  /** A folder the account can read, with at least one file somewhere below it. */
  root: string
  /** The provider's folder test, as the CLI passes it to `syncDocuments`. */
  isFolder(file: M): boolean
  /** A folder that is also a document (a page with sub-pages), as the CLI passes it to `syncDocuments`. */
  isDocument?(file: M): boolean
  /**
   * Makes a change on the provider's side (a new or edited file) for the change feed to list, or, for a source without
   * a feed, for the next sync to find; absent skips that check.
   */
  change?(): Promise<void>
  /** Takes one document out on the provider's side and names it; a source without a feed must drop it on the next sync. */
  remove?(): Promise<string>
  /**
   * Adds a file inside a folder two levels below the root on the provider's side, and names both. A round of changes
   * lists only the direct children of a folder the feed names, so the feed must name the new file or its own folder;
   * absent skips that case.
   */
  addNested?(): Promise<{ file: string; folder: string }>
  /** An id the provider does not know; absent skips that case. */
  missing?: string
  /** Faults for the opt-in fault cases. */
  faults?: DocumentSourceFaults<M>
}

const MAX_ENTRIES = 500

// Each listing is given the folder as listed, as the sync gives it: a source that addresses by path reads it there.
const walk = async <M extends SourceFile>({ source, root, isFolder }: DocumentSourceFixture<M>) => {
  const seen = new Map<string, M>()
  const stack = [await source.metadata(root)]
  while (stack.length) {
    const parent = stack.pop() as M
    for (const child of await source.children(parent.id, parent)) {
      assert.ok(
        child.parents.includes(parent.id),
        `${child.id} is a child of ${parent.id} and names it among its parents`,
      )
      if (seen.has(child.id)) continue
      seen.set(child.id, child)
      assert.ok(seen.size <= MAX_ENTRIES, `more than ${MAX_ENTRIES} entries under the fixture's root`)
      if (isFolder(child)) stack.push(child)
    }
  }
  return [...seen.values()]
}

/** What the sync imports: a file, or a folder the provider calls a document too. */
const isImported = <M extends SourceFile>(fixture: DocumentSourceFixture<M>, entry: M) =>
  !fixture.isFolder(entry) || fixture.isDocument?.(entry) === true

const isTime = (value: string | undefined) => value === undefined || !Number.isNaN(Date.parse(value))

/** Within any change feed's overlap: a computer's clock that is off by more is broken, not skewed. */
const SKEW_MS = 10 * 60_000
/** Slow enough that a run under the MCP deadline cannot read the fixture's tree in one go. */
const SLOW_CALL_MS = 15_000
const MOST_SYNCS = 50

const READS = new Set(["metadata", "children", "childrenPage", "content", "bytes", "startToken", "changes"])

/** The source with `before` run ahead of each provider read: the case counts, slows or cuts off the calls. */
const watched = <M extends SourceFile>(source: DocumentSource<M>, before: () => void): DocumentSource<M> =>
  new Proxy(source, {
    get(target, name) {
      const value = Reflect.get(target, name)
      if (typeof value !== "function") return value
      // Bound to the adapter itself: a class with #private fields refuses a proxy as `this`.
      if (!READS.has(String(name))) return value.bind(target)
      return (...args: unknown[]) => {
        before()
        return value.apply(target, args)
      }
    },
  })

/**
 * Syncs until the pass is complete, and gives the last call's answer and ids, every file the calls skipped, and how
 * many reads they made.
 */
const finish = async <M extends SourceFile>(sync: NonNullable<DocumentSourceFaults<M>["sync"]>) => {
  let reads = 0
  const skipped = new Set<string>()
  for (let call = 1; call <= MOST_SYNCS; call++) {
    const { result, saved } = await sync({
      wrap: (source) =>
        watched(source, () => {
          reads++
        }),
    })
    for (const one of result.skipped) skipped.add(one.id)
    if (result.complete && result.pending === 0) return { result, saved: [...saved].sort(), skipped, reads }
  }
  throw new assert.AssertionError({ message: `the sync is still unfinished after ${MOST_SYNCS} calls` })
}

/** What every documents adapter answers, whatever the provider: run each case in the adapter's tests. */
export const documentSourceContract = <M extends SourceFile>(
  make: () => DocumentSourceFixture<M> | Promise<DocumentSourceFixture<M>>,
): ContractCase[] => {
  const cases: ContractCase[] = [
    {
      name: "identity: the signed-in account, the same on every call",
      async run() {
        const { source } = await make()
        const first = await source.identity()
        assert.equal(typeof first, "string")
        assert.ok(first.trim(), "identity() names the account")
        assert.equal(await source.identity(), first, "identity() does not change between calls")
      },
    },
    {
      name: "metadata: the root is a readable folder under its own id",
      async run() {
        const fixture = await make()
        const root = await fixture.source.metadata(fixture.root)
        assert.equal(root.id, fixture.root)
        assert.ok(fixture.isFolder(root), "the root is a folder")
        assert.equal(root.trashed, false)
      },
    },
    {
      name: "children: every entry has an id, a name, a URL and times that parse, and metadata gives it back",
      async run() {
        const fixture = await make()
        const entries = await walk(fixture)
        assert.ok(
          entries.some((entry) => isImported(fixture, entry)),
          "the root has at least one document below it",
        )
        for (const entry of entries) {
          assert.ok(entry.id && entry.name.trim(), `${entry.id} has an id and a name`)
          assert.equal(typeof entry.url, "string", `${entry.id} has a URL`)
          assert.equal(typeof entry.canDownload, "boolean", `${entry.id} says whether it can be downloaded`)
          assert.ok(isTime(entry.modifiedAt) && isTime(entry.createdAt), `${entry.id}'s times parse`)
          assert.equal(
            (await fixture.source.metadata(entry.id, entry)).id,
            entry.id,
            `metadata(${entry.id}) is the same file`,
          )
        }
      },
    },
    {
      name: "content: a document's text, Markdown, tabs and bytes, under its own metadata",
      async run() {
        const fixture = await make()
        const files = (await walk(fixture)).filter((entry) => isImported(fixture, entry) && entry.canDownload)
        assert.ok(files.length > 0, "the root has a file that can be downloaded")
        for (const file of files.slice(0, 5)) {
          const content = await fixture.source.content(file.id, undefined, file)
          assert.equal(content.metadata.id, file.id)
          assert.equal(typeof content.text, "string")
          assert.equal(typeof content.markdown, "string")
          assert.ok(Array.isArray(content.tabs), "tabs is a list, empty for a document without tabs")
          for (const tab of content.tabs)
            assert.ok(typeof tab.id === "string" && typeof tab.title === "string" && typeof tab.text === "string")
          const bytes = await fixture.source.bytes(file.id, file)
          assert.ok(bytes instanceof Uint8Array, `bytes(${file.id}) is a Uint8Array`)
        }
      },
    },
    {
      name: "changes: a start token, then pages that each give the next cursor and say what was removed",
      async run() {
        const fixture = await make()
        const { source } = fixture
        if (!source.startToken || !source.changes) {
          assert.ok(!source.startToken && !source.changes, "a source has both startToken() and changes(), or neither")
          return
        }
        const token = await source.startToken()
        assert.ok(typeof token === "string" && token, "startToken() gives a cursor")
        await fixture.change?.()
        const page = await source.changes(token)
        assert.ok(Array.isArray(page.items), "a change page has items")
        if (fixture.change) assert.ok(page.items.length > 0, "the change made after startToken() is in the feed")
        assert.ok(typeof page.cursor === "string" && page.cursor, "a change page gives the next cursor")
        for (const item of page.items) {
          assert.equal(typeof item.removed, "boolean", `change ${item.id} says whether it was removed`)
          if (!item.removed && item.file) assert.equal(item.file.id, item.id, `change ${item.id} carries its file`)
        }
      },
    },
  ]
  cases.push({
    name: "changes: a file added deep in the tree is named in the feed, itself or by its own folder",
    async run() {
      const { source, addNested } = await make()
      if (!addNested || !source.startToken || !source.changes) return
      const token = await source.startToken()
      const { file, folder } = await addNested()
      const named = new Set((await source.changes(token)).items.map((item) => item.id))
      assert.ok(named.has(file) || named.has(folder), `the feed names ${file} or its folder ${folder}`)
    },
  })
  cases.push({
    name: "childrenPage: the pages of a folder, cursor to cursor, list what children() lists, each entry once",
    async run() {
      const fixture = await make()
      const { source } = fixture
      if (!source.childrenPage) return
      const stack = [await source.metadata(fixture.root)]
      while (stack.length) {
        const parent = stack.pop() as M
        const paged: string[] = []
        let cursor: string | undefined
        for (let pages = 1; ; pages++) {
          assert.ok(pages <= MAX_ENTRIES, `childrenPage(${parent.id}) ends`)
          const page = await source.childrenPage(parent.id, cursor, parent)
          assert.ok(Array.isArray(page.files), "a page has files")
          paged.push(...page.files.map((file) => file.id))
          for (const file of page.files) if (fixture.isFolder(file)) stack.push(file)
          if (page.cursor === undefined) break
          assert.ok(typeof page.cursor === "string" && page.cursor !== cursor, "a page gives a new cursor or none")
          cursor = page.cursor
        }
        assert.equal(new Set(paged).size, paged.length, `childrenPage(${parent.id}) lists each entry once`)
        const listed = (await source.children(parent.id, parent)).map((file) => file.id)
        assert.deepEqual([...paged].sort(), [...listed].sort(), `childrenPage(${parent.id}) lists what children() does`)
      }
    },
  })
  cases.push({
    name: "without a change feed: the next sync finds a new or edited file and drops a removed one",
    async run() {
      const fixture = await make()
      const sync = fixture.faults?.sync
      if (fixture.source.changes || !sync || (!fixture.change && !fixture.remove)) return
      const before = await finish(sync)
      const removed = await fixture.remove?.()
      if (removed !== undefined)
        assert.ok(before.saved.includes(removed), `the first sync holds ${removed} before it is removed`)
      await fixture.change?.()
      const after = await finish(sync)
      if (removed !== undefined) assert.ok(!after.saved.includes(removed), `the next sync drops the removed ${removed}`)
      if (fixture.change)
        assert.ok(after.result.saved > 0, "the next sync saves the new or edited file, though no feed named it")
    },
  })
  cases.push({
    name: "metadata: an id the provider does not know is not_found",
    async run() {
      const { source, missing } = await make()
      if (missing === undefined) return
      await assert.rejects(source.metadata(missing), (error) => isCliError(error) && error.code === "not_found")
    },
  })
  return [...cases, ...faultCases(make)]
}

const faultCases = <M extends SourceFile>(
  make: () => DocumentSourceFixture<M> | Promise<DocumentSourceFixture<M>>,
): ContractCase[] => [
  ...([403, 404] as const).map((status) => ({
    name: `faults: a child that answers ${status} is ${status === 403 ? "permission_error" : "not_found"}, and a sync skips it and imports the rest`,
    async run() {
      const fixture = await make()
      const deny = fixture.faults?.deny
      if (!deny) return
      const listed = new Map((await walk(fixture)).map((entry) => [entry.id, entry]))
      const id = await deny(status)
      const code = status === 403 ? "permission_error" : "not_found"
      await assert.rejects(
        fixture.source.content(id, undefined, listed.get(id)),
        (error) => isCliError(error) && error.code === code,
        `content(${id}) after a ${status} is ${code}`,
      )
      const sync = fixture.faults?.sync
      if (!sync) return
      // A refused file is skipped as a gone one is, so the pass completes and its change cursor moves on.
      const { saved, skipped } = await finish(sync)
      assert.ok(!saved.includes(id), `the sync does not hold ${id}, which answers ${status}`)
      assert.ok(saved.length > 0, `the sync imports the documents that still answer beside ${id}`)
      if (status === 403) assert.ok(skipped.has(id), `the sync names ${id} among its skipped files with the reason`)
      if (!fixture.change) return
      await fixture.change()
      // Throws when the refused file holds the next pass too.
      await finish(sync)
    },
  })),
  {
    name: "faults: a clock off by ten minutes either way loses no change",
    async run() {
      const first = await make()
      if (!first.faults?.skewed || !first.change || !first.source.changes) return
      for (const ms of [SKEW_MS, -SKEW_MS]) {
        const fixture = ms === SKEW_MS ? first : await make()
        const source = (await fixture.faults?.skewed?.(ms)) as DocumentSource<M>
        const { startToken, changes } = source as Required<Pick<DocumentSource<M>, "startToken" | "changes">>
        const token = await startToken.call(source)
        await fixture.change?.()
        const page = await changes.call(source, token)
        assert.ok(page.items.length > 0, `a change is in the feed with this computer's clock ${ms / 60_000} min off`)
      }
    },
  },
  {
    name: "faults: a second profile on the same token is the same account and sees the same tree",
    async run() {
      const fixture = await make()
      const other = await fixture.faults?.sameToken?.()
      if (!other) return
      assert.equal(await other.identity(), await fixture.source.identity(), "both profiles name one account")
      const ids = async (source: DocumentSource<M>) =>
        (await walk({ ...fixture, source })).map((entry) => entry.id).sort()
      assert.deepEqual(await ids(other), await ids(fixture.source), "both profiles list the same tree")
    },
  },
  {
    name: "faults: an interrupted sync goes on where it stopped and ends with what one whole sync holds",
    async run() {
      const whole = await make()
      if (!whole.faults?.sync) return
      const expected = await finish(whole.faults.sync)
      const fixture = await make()
      const sync = fixture.faults?.sync as NonNullable<DocumentSourceFaults<M>["sync"]>
      const stop = new AbortController()
      let reads = 0
      const cut = await sync({
        signal: stop.signal,
        wrap: (source) =>
          watched(source, () => {
            if (++reads > 2) stop.abort()
          }),
      }).then(
        ({ result }) => result.complete === false,
        (error: unknown) => {
          if (!stop.signal.aborted) throw error
          return true
        },
      )
      assert.ok(stop.signal.aborted, "the fixture's tree takes more than two reads, so the run is cut short")
      assert.ok(cut, "the cut run stops: it is cancelled or answers complete: false, it does not read on")
      const resumed = await finish(sync)
      assert.deepEqual(resumed.saved, expected.saved, "the resumed sync holds what one whole sync does")
      assert.ok(resumed.reads < expected.reads, "the resumed sync reads less than a whole one: it went on, not over")
    },
  },
  {
    name: "faults: under the MCP's 45 s deadline a slow provider's sync stops in time, and the next goes on",
    async run() {
      const whole = await make()
      if (!whole.faults?.sync) return
      const expected = await finish(whole.faults.sync)
      const fixture = await make()
      const sync = fixture.faults?.sync as NonNullable<DocumentSourceFaults<M>["sync"]>
      let clock = 0
      const now = () => clock
      let stopped = false
      for (let call = 1; call <= MOST_SYNCS; call++) {
        const deadline: Deadline = { endsAt: clock + DEFAULT_AGENT_COOPERATIVE_MS, ms: DEFAULT_AGENT_COOPERATIVE_MS }
        const { result, saved } = await sync({
          budget: runBudget({ deadline, now, requestMs: SLOW_CALL_MS }),
          deadline,
          now,
          wrap: (source) =>
            watched(source, () => {
              clock += SLOW_CALL_MS
            }),
        })
        assert.ok(
          clock <= deadline.endsAt - ANSWER_RESERVE_MS,
          `sync ${call} left time to answer before its deadline: ended ${clock - deadline.endsAt} ms from it`,
        )
        if (result.complete && result.pending === 0) {
          assert.ok(stopped, "a slow provider's tree takes more than one run under the deadline")
          assert.deepEqual([...saved].sort(), expected.saved, "the runs together hold what one whole sync does")
          return
        }
        stopped = true
      }
      throw new assert.AssertionError({ message: `the sync is still unfinished after ${MOST_SYNCS} runs` })
    },
  },
]
