import type { CommandInfo } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { commandMap, comparePrograms, compareTools, inlineJson, matrixRows, valueDifferences } from "./deep.js"
import type { CommandsJson } from "./manifest.js"

const node = (path: string[], changes: Partial<CommandInfo> = {}): CommandInfo => ({
  path,
  name: path.at(-1) ?? "",
  description: "read",
  usage: path.join(" "),
  origin: "handwritten",
  arguments: [],
  options: [],
  commands: [],
  ...changes,
})
const side = (cli: string, command: CommandInfo): CommandsJson => ({ cli, globalOptions: [], commands: [command] })
const tool = (name: string, schema: unknown, annotations = {}) => ({ name, inputSchema: schema, annotations })

describe("direct parity evidence", () => {
  it("finds a renamed nested option and an optional argument without consulting manifest exemptions", () => {
    const left = node(["messages"], {
      commands: [
        node(["messages", "download"], {
          arguments: [{ name: "message", required: true, variadic: false, description: "id" }],
          options: [{ flags: "--output <dir>", description: "save", takesValue: true, mandatory: false }],
        }),
      ],
    })
    const right = node(["messages"], {
      commands: [
        node(["messages", "download"], {
          arguments: [{ name: "message", required: false, variadic: false, description: "id" }],
          options: [{ flags: "--output-dir <dir>", description: "save", takesValue: true, mandatory: false }],
        }),
      ],
    })
    const result = comparePrograms(side("max", left), side("tg", right))
    expect(result.commands.find((one) => one.path === "messages download")?.contracts.map((one) => one.path)).toEqual([
      "arguments",
      "options.--output",
      "options.--output-dir",
    ])
  })
  it("keeps aliases/defaults and global contracts separate from prose and preserves false vs absent", () => {
    const command = node(["list"], {
      options: [{ flags: "-n, --limit <n>", default: 20, takesValue: true, mandatory: false, description: "read" }],
    })
    const changed = node(["list"], {
      options: [{ flags: "--limit <n>", default: 30, takesValue: true, mandatory: false, description: "show" }],
      mutates: false,
    })
    const result = comparePrograms(side("a", command), side("b", changed))
    expect(result.commands[0]?.contracts.map((one) => one.path)).toEqual([
      "mutates",
      "options.--limit.default",
      "options.--limit.flags",
    ])
    expect(result.commands[0]?.help).toContainEqual({
      path: "options.--limit.description",
      left: "read",
      right: "show",
    })
  })
  it("does not mistake reordered schema sets for a difference, but detects bounds, names and idempotence", () => {
    const a = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { enum: ["x", "y"], description: "provider name" } },
    }
    const b = {
      properties: { a: { description: "other name", enum: ["y", "x"] } },
      required: ["b", "a"],
      type: "object",
    }
    expect(
      compareTools({ cli: "max", tools: [tool("max_search", a)] }, { cli: "tg", tools: [tool("tg_search", b)] })[0]
        ?.contracts,
    ).toEqual([])
    const changed = compareTools(
      { cli: "max", tools: [tool("max_search", a, { idempotentHint: true })] },
      {
        cli: "tg",
        tools: [tool("tg_search", { ...b, additionalProperties: false }, { idempotentHint: false })],
      },
    )
    expect(changed[0]?.contracts.map((one) => one.path)).toEqual([
      "annotations.idempotentHint",
      "inputSchema.additionalProperties",
    ])
  })
  it("reports missing tools without treating absent output schemas as proof of matching answers", () => {
    const result = compareTools({ cli: "a", tools: [tool("a_only", {})] }, { cli: "b", tools: [] })
    expect(result[0]).toMatchObject({ name: "only", present: ["a"], contracts: [] })
  })
  it("rejects duplicate paths and preserves array order for positional arguments", () => {
    expect(() => commandMap({ cli: "a", globalOptions: [], commands: [node(["a"]), node(["a"])] })).toThrow("duplicate")
    expect(valueDifferences(["a", "b"], ["b", "a"], "arguments")).toHaveLength(1)
  })
  it("keeps a matrix exemption as an exemption, including its complete reason", () => {
    expect(matrixRows("| `serve` | `--idle` | ⛔ | process | lifecycle |\n| *global* | `--yes` | ✅ | |")).toEqual([
      { command: "serve", option: "--idle", status: "⛔", reason: "process|lifecycle" },
      { command: "*global*", option: "--yes", status: "✅", reason: "" },
    ])
  })
})

it("measures global response contracts and does not silently collapse duplicate tool names", () => {
  const base = { ...side("a", node(["status"])), contract: 0, exitCodes: { timeout: 9 } }
  const other = { ...side("b", node(["status"])), contract: 1, exitCodes: { timeout: 10 } }
  expect(comparePrograms(base, other).globals.map((one) => one.path)).toEqual(["contract", "exitCodes.timeout"])
  expect(() =>
    compareTools({ cli: "a", tools: [tool("a_read", {}), tool("a_read", {})] }, { cli: "b", tools: [] }),
  ).toThrow("duplicate tool name")
})

it("keeps missing fields and readable JSON fence boundaries in audit evidence", () => {
  expect(valueDifferences({ optional: false }, {})).toEqual([{ path: "optional", left: false }])
  expect(inlineJson({ text: "`quoted`" })).toBe('``{"text":"`quoted`"}``')
})

it("preserves schema properties named title/description and literal defaults while ignoring annotations", () => {
  const a = {
    type: "object",
    properties: { title: { type: "string", minLength: 1 }, description: { type: "string" } },
    default: { description: "first", required: ["a", "b"] },
  }
  const b = {
    ...a,
    properties: { title: { type: "string", minLength: 2 }, description: { type: "number" } },
    default: { description: "second", required: ["b", "a"] },
  }
  const result = compareTools({ cli: "a", tools: [tool("a_create", a)] }, { cli: "b", tools: [tool("b_create", b)] })
  expect(result[0]?.contracts.map((one) => one.path)).toEqual([
    "inputSchema.default.description",
    "inputSchema.default.required",
    "inputSchema.properties.description.type",
    "inputSchema.properties.title.minLength",
  ])
})

it("does not treat property-map names as default/enum data when stripping documentation", () => {
  for (const name of ["title", "description", "default", "const", "enum"]) {
    const left = { type: "object", properties: { [name]: { type: "string", description: "left docs" } } }
    const right = { type: "object", properties: { [name]: { type: "string", description: "right docs" } } }
    expect(
      compareTools({ cli: "a", tools: [tool("a_read", left)] }, { cli: "b", tools: [tool("b_read", right)] })[0]
        ?.contracts,
    ).toEqual([])
  }
})
