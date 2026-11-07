import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterAll, beforeAll, describe, it } from "vitest"
import { addCalendarCommands } from "../calendar/cli/index.js"
import { fakeCalendarSource } from "../calendar/testing/index.js"
import { environmentOf, inCommandRun, outputFor } from "../cli/context.js"
import { itemOf, renderAnswer } from "../cli/envelope.js"
import type { ProgramDefinition, RunOptions } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { addMeetingCommands } from "../meetings/cli/index.js"
import { fakeMeetingSource, memoryMeetingStore } from "../meetings/testing/index.js"
import type { AppIdentity } from "../ports/app.js"
import { type MessageStore, openStore } from "../store/store.js"
import { runScopeCases } from "./index.js"

const app: AppIdentity = {
  command: "groups",
  appName: "groups-cli",
  envPrefix: "GROUPS",
  description: "synthetic",
  version: "1.0.0",
  messenger: false,
}
const home = mkdtempSync(join(tmpdir(), "core-groups-"))
const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, GROUPS_CONFIG_DIR: join(home, "config") }

const hanging = <T extends object>(target: T): T =>
  new Proxy(target, {
    get: (object, key) =>
      typeof Reflect.get(object, key) === "function" ? () => new Promise(() => {}) : Reflect.get(object, key),
  })

type Given = RunOptions & { silent?: boolean }

// The meetings commands read their source before the run opens, so the case's choice of fake is kept here.
let silentNext = false

describe("cli-core's meetings commands run inside its run", () => {
  const source = fakeMeetingSource()
  const definition: ProgramDefinition = {
    app,
    configuration: settingsFor(app),
    commands: () => {
      const root = new Command(app.command)
      let sync: Command | undefined
      addMeetingCommands(root, {
        store: memoryMeetingStore(),
        accountId: 1,
        get source() {
          return silentNext ? hanging(source) : source
        },
        write: (value) => {
          if (sync) renderAnswer(sync, outputFor(sync), itemOf(value))
        },
        inRun: (command, body) => {
          sync = command
          return inCommandRun(command, body)
        },
      })
      return [...root.commands]
    },
  }
  const cases = runScopeCases({
    definition,
    commands: { "meetings sync": ["work", "meetings", "sync"] },
    answering: () => {
      silentNext = false
      return { env }
    },
    silent: () => {
      silentNext = true
      return { env }
    },
  })
  for (const one of cases) it(one.name, () => one.run())
})

describe("cli-core's calendar commands run inside its run", () => {
  let store: MessageStore
  let accountId = 0
  const account = { provider: "google-calendar", account: "owner@example.com" }
  const source = fakeCalendarSource({
    calendars: [
      {
        externalId: "primary",
        title: "Work",
        timezone: "UTC",
        accessRole: "owner",
        primary: true,
        syncByDefault: true,
      },
    ],
    search: true,
  })
  beforeAll(async () => {
    store = await openStore({ path: join(home, "calendar.db") })
    await store.accounts.registerProvider({ name: "google-calendar", kind: "events", aliases: [], command: "gcal" })
    accountId = await store.accounts.saveAccount(account, { name: null })
  })
  afterAll(() => store.close())

  const definition: ProgramDefinition = {
    app,
    configuration: settingsFor(app),
    commands: () => {
      const root = new Command(app.command)
      addCalendarCommands(root, {
        app,
        freeBusy: true,
        serverSearch: true,
        open: async (command) => {
          const given = environmentOf<Given>(command).silent ? hanging(source) : source
          return { profile: "work", account, accountId, store: store.calendar, messages: store, source: () => given }
        },
      })
      return [...root.commands]
    },
  }
  const cases = runScopeCases({
    definition,
    commands: {
      "calendars list": ["work", "calendars", "list"],
      sync: ["work", "sync"],
      "calendars busy": ["work", "calendars", "busy", "person:ana@example.com"],
      "search events": ["work", "search", "events", "planning", "--backend", "server"],
    },
    answering: () => ({ env }),
    silent: () => ({ env, silent: true }),
  })
  for (const one of cases) it(one.name, () => one.run())
})
