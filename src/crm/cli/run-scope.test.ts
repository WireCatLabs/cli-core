import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterAll, beforeAll, describe, it } from "vitest"
import { environmentOf } from "../../cli/context.js"
import { type ProgramDefinition, type RunOptions, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { CRM_OPENS } from "../../domain/providers.js"
import { runScopeCases } from "../../kit/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const configuration = settingsFor(APP)
const home = mkdtempSync(join(tmpdir(), "crm-run-scope-"))
const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_CONFIG_DIR: join(home, "config") }

const source = fakeCrmSource()
for (const id of ["d1", "d2", "d3", "d4"]) source.put("deal", exampleDeal(id))

const hanging = <T extends object>(target: T): T =>
  new Proxy(target, {
    get: (object, key) =>
      typeof Reflect.get(object, key) === "function" ? () => new Promise(() => {}) : Reflect.get(object, key),
  })

let store: MessageStore

const open = async (command: Command): Promise<CrmRun> => {
  const given = environmentOf<RunOptions & { crm?: typeof source }>(command).crm ?? source
  return {
    profile: "work",
    account: { provider: "example-crm", account: "portal" },
    store,
    source: () => given,
    writes: () => ({
      writer: given,
      app: APP,
      self: "7",
      env,
      settings: () => ({ profile: "work", permissions: {}, permissionSources: {}, sendsPerHour: 1000 }),
    }),
  }
}

const definition: ProgramDefinition = {
  app: APP,
  configuration,
  commands: () => {
    const root = new Command("crm")
    addCrmCommands(root, {
      app: APP,
      open,
      writes: { kinds: ["deal"], verbs: ["create", "update", "move", "close", "remove"], idempotent: false },
    })
    return [...root.commands]
  },
}

beforeAll(async () => {
  store = await openStore({ path: join(home, "store.db") })
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  await run(["work", "sync", "--json"], definition, { streams: captureStreams(), tty: false, env })
})
afterAll(() => store.close())

describe("the shared CRM commands run inside cli-core's run", () => {
  const cases = runScopeCases({
    definition,
    commands: {
      sync: ["work", "sync"],
      "deals create": ["work", "deals", "create", "--title", "Example kitchen"],
      "deals update": ["work", "deals", "update", "deal:1", "--title", "Example office"],
      "deals move": ["work", "deals", "move", "deal:2", "Quote sent"],
      "deals close": ["work", "deals", "close", "deal:3", "lost"],
      "deals delete": ["work", "deals", "delete", "deal:4", "--yes"],
    },
    answering: () => ({ env }),
    silent: () => ({ env, crm: hanging(source) }),
  })
  for (const one of cases) it(one.name, () => one.run())
})
