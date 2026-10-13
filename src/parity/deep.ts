import type { CommandInfo, OptionInfo } from "@wirecat/cli-base/commands"
import { type CommandsJson, longName } from "./manifest.js"

export interface Difference {
  path: string
  left?: unknown
  right?: unknown
}
export interface CommandComparison {
  path: string
  present: string[]
  contracts: Difference[]
  help: Difference[]
}
export interface ProgramComparison {
  sides: string[]
  commands: CommandComparison[]
  globals: Difference[]
  globalHelp: Difference[]
}
export interface CapturedTool {
  name: string
  description?: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations?: unknown
}
export interface ToolComparison {
  name: string
  present: string[]
  contracts: Difference[]
  help: Difference[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const canonical = (value: unknown, prose: boolean, key = ""): unknown => {
  if (Array.isArray(value)) {
    const items = value.map((one) => canonical(one, prose))
    return !prose && ["required", "enum", "choices"].includes(key)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : items
  }
  if (!record(value)) return value
  const namedMap = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((name) => prose || namedMap || !["description", "title"].includes(name))
      .map((name) => {
        const literal = prose || (!namedMap && ["default", "const", "enum", "examples", "annotations"].includes(name))
        const next = canonical(value[name], literal, name)
        if (!prose && name === "enum" && Array.isArray(next))
          next.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        return [name, next]
      }),
  )
}

export const valueDifferences = (left: unknown, right: unknown, path = ""): Difference[] => {
  if (JSON.stringify(left) === JSON.stringify(right)) return []
  if (record(left) && record(right))
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => valueDifferences(left[key], right[key], path ? `${path}.${key}` : key))
  return [{ path, ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) }]
}

export const commandMap = (program: CommandsJson): Map<string, CommandInfo> => {
  const result = new Map<string, CommandInfo>()
  const visit = (commands: readonly CommandInfo[]) => {
    for (const command of commands) {
      const path = command.path.join(" ")
      if (result.has(path)) throw new Error(`duplicate command path: ${path}`)
      result.set(path, command)
      visit(command.commands)
    }
  }
  visit(program.commands)
  return result
}

const optionMap = (options: readonly OptionInfo[]) =>
  Object.fromEntries(options.map((option) => [longName(option.flags), option]))
const optionContracts = (options: readonly OptionInfo[]) => canonical(optionMap(options), false)
const proseOf = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(proseOf)
  if (!record(value)) return undefined
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([key, one]) => {
        if (["description", "title"].includes(key)) return [[key, one]]
        const nested = proseOf(one)
        return nested === undefined ? [] : [[key, nested]]
      }),
  )
}

export const comparePrograms = (left: CommandsJson, right: CommandsJson): ProgramComparison => {
  const maps = [commandMap(left), commandMap(right)]
  const names = [left.cli, right.cli]
  const commands = [...new Set(maps.flatMap((map) => [...map.keys()]))].sort().map((path) => {
    const [a, b] = maps.map((map) => map.get(path))
    const present = names.filter((_name, index) => maps[index]?.has(path))
    if (!a || !b) return { path, present, contracts: [], help: [] }
    const contract = (one: CommandInfo) => ({
      arguments: canonical(one.arguments, false),
      options: optionContracts(one.options),
      mutates: one.mutates,
      state: one.state,
      origin: one.origin,
    })
    return {
      path,
      present,
      contracts: valueDifferences(contract(a), contract(b)),
      help: valueDifferences(
        proseOf({ description: a.description, arguments: a.arguments, options: optionMap(a.options) }),
        proseOf({ description: b.description, arguments: b.arguments, options: optionMap(b.options) }),
      ),
    }
  })
  return {
    sides: names,
    commands,
    globals: valueDifferences(
      {
        options: optionContracts(left.global_options),
        contract: (left as CommandsJson & { contract?: number }).contract,
        exitCodes: (left as CommandsJson & { exit_codes?: unknown }).exit_codes,
      },
      {
        options: optionContracts(right.global_options),
        contract: (right as CommandsJson & { contract?: number }).contract,
        exitCodes: (right as CommandsJson & { exit_codes?: unknown }).exit_codes,
      },
    ),
    globalHelp: valueDifferences(proseOf(optionMap(left.global_options)), proseOf(optionMap(right.global_options))),
  }
}

export const compareTools = (
  left: { cli: string; tools: CapturedTool[] },
  right: { cli: string; tools: CapturedTool[] },
): ToolComparison[] => {
  const map = (one: typeof left) => {
    const result = new Map<string, CapturedTool>()
    const prefix = `${one.cli}_`
    for (const tool of one.tools) {
      const name = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
      if (result.has(name)) throw new Error(`duplicate tool name: ${name}`)
      result.set(name, tool)
    }
    return result
  }
  const a = map(left)
  const b = map(right)
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((name) => {
    const one = a.get(name)
    const two = b.get(name)
    const contract = (tool: CapturedTool) =>
      canonical(
        { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations },
        false,
      )
    return {
      name,
      present: [left.cli, right.cli].filter((_cli, index) => (index === 0 ? a : b).has(name)),
      contracts: one && two ? valueDifferences(contract(one), contract(two)) : [],
      help: one && two ? valueDifferences(proseOf(one), proseOf(two)) : [],
    }
  })
}

export interface MatrixRow {
  command: string
  option: string
  status: string
  reason: string
}
export const matrixRows = (markdown: string): MatrixRow[] =>
  markdown.split("\n").flatMap((line) => {
    if (!/^\| (?:`|\*global\*)/.test(line)) return []
    const fields = line
      .split("|")
      .slice(1, -1)
      .map((one) => one.trim().replace(/^`|`$/g, ""))
    const [command, option, status, ...reason] = fields
    if (!command || option === undefined || !status) return []
    return [{ command, option, status, reason: reason.join("|") }]
  })

export const inlineJson = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "undefined"
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((one) => one.length)) + 1)
  return `${fence}${text}${fence}`
}
