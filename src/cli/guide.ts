import { readdirSync, readFileSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, type Option } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { environmentOf, outputFor } from "./context.js"
import { NO_EFFECTS } from "./effects.js"
import { itemOf, listOf, renderAnswer } from "./envelope.js"
import { commandWords, PROFILE_FREE, usableProfileName } from "./profile.js"

export interface GuideStep {
  /** The command as a person types it: the tool's name first, no profile — `tg review --since 1d`. */
  run: string
  why: string
}

export interface Scenario {
  name: string
  title: string
  goal: string
  steps: GuideStep[]
  look: string[]
}

/** A scenario another tool holds — memo's cross-tool ones — listed by reference under "Works with". */
export interface GuideReference {
  tool: string
  name: string
  title: string
}

/** memo's cross-tool scenarios: the one source of the titles every tool lists, and memo's files must carry. */
export const MEMO_SCENARIOS = {
  personBrief: { tool: "memo", name: "person-brief", title: "One person across every tool" },
  decisionTrail: { tool: "memo", name: "decision-trail", title: "What did we decide about X, across every source" },
} as const satisfies Record<string, GuideReference>

export interface GuideOptions {
  /** Absolute path of the tool's scenario files: `fileURLToPath(new URL("../scenarios", import.meta.url))`. */
  directory: string
  worksWith?: readonly GuideReference[]
  /** `false` for a tool whose commands take no leading profile. */
  profile?: boolean
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FIELDS = new Set(["title", "goal", "steps", "look"])
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

/** One scenario file, or what is wrong with it. The Markdown body is for the site's page; the CLI reads none of it. */
export const parseScenario = async (
  file: string,
  content: string,
): Promise<{ scenario?: Scenario; problems: string[] }> => {
  const name = basename(file, ".md")
  const at = (problem: string) => `${basename(file)}: ${problem}`
  if (!NAME.test(name)) return { problems: [at("the file name is the scenario's name: lower case words and dashes")] }
  const match = FRONT_MATTER.exec(content)
  if (!match) return { problems: [at("needs front matter between --- lines")] }
  // Loaded here, not at the top: every tool start loads this module, and only `guide` reads YAML.
  const { parseDocument } = await import("yaml")
  const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true })
  if (yaml.errors.length > 0) return { problems: [at("front matter is not valid YAML")] }
  const data = yaml.toJS({ maxAliasCount: 0 }) as unknown
  if (!data || typeof data !== "object" || Array.isArray(data)) return { problems: [at("front matter is not a map")] }
  const fields = data as Record<string, unknown>
  const problems = Object.keys(fields)
    .filter((key) => !FIELDS.has(key))
    .map((key) => at(`unknown field ${key}; the fields are ${[...FIELDS].join(", ")}`))
  if (!text(fields.title)) problems.push(at("title is a line of text"))
  if (!text(fields.goal)) problems.push(at("goal is a line of text"))
  const steps = Array.isArray(fields.steps) ? (fields.steps as unknown[]) : []
  if (steps.length === 0) problems.push(at("steps is a list of { run, why }"))
  steps.forEach((step, index) => {
    const one = (step ?? {}) as Record<string, unknown>
    if (!text(one.run) || !text(one.why)) problems.push(at(`step ${index + 1} needs run and why`))
  })
  const look = typeof fields.look === "string" ? [fields.look] : fields.look
  if (!Array.isArray(look) || look.length === 0 || !look.every(text))
    problems.push(at("look is what to look at in the output: a line or a list of lines"))
  if (problems.length > 0) return { problems }
  return {
    scenario: {
      name,
      title: String(fields.title).trim(),
      goal: String(fields.goal).trim(),
      steps: (steps as GuideStep[]).map(({ run, why }) => ({ run: run.trim(), why: why.trim() })),
      look: (look as string[]).map((line) => line.trim()),
    },
    problems: [],
  }
}

export const loadScenarios = async (directory: string): Promise<{ scenarios: Scenario[]; problems: string[] }> => {
  let files: string[]
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
  } catch {
    return { scenarios: [], problems: [`${directory}: no such directory`] }
  }
  const parsed = await Promise.all(
    files.sort().map((file) => parseScenario(file, readFileSync(join(directory, file), "utf8"))),
  )
  return {
    scenarios: parsed.flatMap(({ scenario }) => (scenario ? [scenario] : [])),
    problems: parsed.flatMap(({ problems }) => problems),
  }
}

/** Only the file names, for the example: building the program parses no scenario. */
const firstScenarioName = (directory: string): string | undefined => {
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md")
      .map((file) => basename(file, ".md"))
      .filter((name) => NAME.test(name))
      .sort()[0]
  } catch {
    return undefined
  }
}

const guides = new WeakMap<Command, GuideOptions>()

const rows = (pairs: readonly (readonly [string, string])[]): string[] => {
  const width = pairs.reduce((most, [left]) => Math.max(most, left.length), 0) + 2
  return pairs.map(([left, right]) => `  ${left.padEnd(width)}${right}`)
}

const listText = (cli: string, scenarios: readonly Scenario[], worksWith: readonly GuideReference[]): string =>
  [
    scenarios.length > 0 ? `Scenarios — ${cli} guide <name> for the steps:` : `${cli} has no scenarios yet.`,
    ...rows(scenarios.map((one) => [one.name, one.title])),
    ...(worksWith.length > 0
      ? ["", "Works with:", ...rows(worksWith.map((one) => [`${one.tool} guide ${one.name}`, one.title]))]
      : []),
  ].join("\n")

const needsProfile = (cli: string, run: string) => {
  const [tool, first] = words(run)
  return tool === cli && first !== undefined && !first.startsWith("-") && !PROFILE_FREE.has(first)
}

const scenarioText = (cli: string, scenario: Scenario, profile: boolean): string =>
  [
    scenario.title,
    "",
    `Goal: ${scenario.goal}`,
    "",
    profile && scenario.steps.some((step) => needsProfile(cli, step.run))
      ? `Steps — account commands start with your profile: ${cli} <profile> …`
      : "Steps:",
    ...scenario.steps.flatMap((step, index) => [`  ${index + 1}. ${step.run}`, `     ${step.why}`]),
    "",
    "Look at:",
    ...scenario.look.map((line) => `  - ${line}`),
  ].join("\n")

/**
 * `<tool> guide` lists the tool's scenarios and the ones it works with; `<tool> guide <name>` prints one: the goal,
 * each step as a command and why, and what to look at. The files are parsed when the command runs, never when the
 * program is built. `checkGuide` validates them in the tool's CI.
 */
export const guideCommand = (app: Pick<AppIdentity, "command">, options: GuideOptions): Command => {
  const first = firstScenarioName(options.directory)
  const command = annotate(new Command("guide"), {
    effects: NO_EFFECTS,
    examples: [`${app.command} guide`, ...(first ? [`${app.command} guide ${first} --json`] : [])],
  })
    .description("scenarios: the commands for a common task, in order, and why each")
    .argument("[name]", "one scenario; without it, the list")
    .action(async function (this: Command, name: string | undefined) {
      const cli = app.command
      const { scenarios, problems } = await loadScenarios(options.directory)
      if (problems.length > 0)
        throw new CliError("configuration_error", `broken scenario files: ${problems.join("; ")}`)
      const worksWith = options.worksWith ?? []
      const output = outputFor(this)
      const { json, jsonl } = this.optsWithGlobals<{ json?: unknown; jsonl?: boolean }>()
      const asText = json === undefined && !jsonl && !environmentOf(this).agent
      if (name === undefined) {
        const items = [
          ...scenarios.map(({ name, title, goal }) => ({
            tool: cli,
            name,
            title,
            goal,
            command: `${cli} guide ${name}`,
          })),
          ...worksWith.map(({ tool, name, title }) => ({ tool, name, title, command: `${tool} guide ${name}` })),
        ]
        if (asText) output.streams.data(listText(cli, scenarios, worksWith))
        else renderAnswer(this, output, listOf("guide", { items, limit: Math.max(1, items.length), has_more: false }))
        return
      }
      const scenario = scenarios.find((one) => one.name === name)
      if (!scenario) {
        const elsewhere = worksWith.find((one) => one.name === name)
        throw new CliError(
          "not_found",
          elsewhere
            ? `"${name}" is ${elsewhere.tool}'s scenario: ${elsewhere.tool} guide ${name}`
            : `no scenario "${name}"; ${cli} guide lists them`,
          { name, available: scenarios.map((one) => one.name) },
        )
      }
      if (asText) output.streams.data(scenarioText(cli, scenario, options.profile !== false))
      else renderAnswer(this, output, itemOf(scenario))
    })
  guides.set(command, options)
  return command
}

const OPERATORS: Record<string, string> = {
  ">": "redirects output to a file",
  "<": "reads input from a file",
  "|": "pipes into another command",
  "&": "runs the command in the background",
  ";": "ends the command there",
  "`": "runs it as a command",
  "$(": "runs it as a command",
  "*": "expands it to file names",
  "?": "expands it to file names",
  "[": "expands it to file names",
}

/**
 * A step split into words as a POSIX shell would — '…' literal, "…" with \ escapes, \ outside quotes — and the
 * characters a shell would act on instead of passing them to the tool. `` ` `` and `$(` still act inside "…".
 */
const scan = (line: string): { words: string[]; live: string[]; open: boolean } => {
  const found: string[] = []
  const live = new Set<string>()
  let word: string | undefined
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string
    const next = line[index + 1]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === "\\" && next !== undefined && (quote === undefined || '$`"\\'.includes(next))) {
      word = (word ?? "") + next
      index++
      continue
    }
    if (char === "`" || (char === "$" && next === "(")) live.add(char === "`" ? "`" : "$(")
    if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ""
    } else if (/\s/.test(char)) {
      if (word !== undefined) found.push(word)
      word = undefined
    } else {
      if (OPERATORS[char]) live.add(char)
      word = (word ?? "") + char
    }
  }
  if (word !== undefined) found.push(word)
  return { words: found, live: [...live], open: quote !== undefined }
}

const words = (line: string): string[] => scan(line).words

/** Characters in a step that a shell would act on: the person who copies it would run something else. */
export const shellProblems = (run: string): string[] => {
  const { live, open } = scan(run)
  return [
    ...live.map((char) => `a shell acts on ${char}: it ${OPERATORS[char]}; put the word in single quotes`),
    ...(open ? ["a quote is never closed"] : []),
  ]
}

const silent = (command: Command) =>
  command.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })

const ownerOf = (chain: readonly Command[], flag: string): { owner: Command; option: Option } | undefined => {
  for (const owner of chain) {
    const option = owner.options.find((one) => one.long === flag || one.short === flag)
    if (option) return { owner, option }
  }
  return undefined
}

const isCommandWord = (program: Command, word: string | undefined): boolean =>
  word !== undefined && commandWords(program).has(word)

const isProfileWord = (word: string | undefined): boolean => {
  if (word === undefined || word.startsWith("-")) return false
  try {
    usableProfileName(word)
    return true
  } catch {
    return false
  }
}

/** What is wrong with one step on this program: the path, each option and its value, the arguments. Never runs it. */
export const checkStep = (program: Command, run: string): string[] => {
  const [tool, ...rest] = words(run)
  if (tool !== program.name()) return [`starts with "${tool ?? ""}", not ${program.name()}`]
  const chain: Command[] = [program]
  let at = program
  // The first word may be the profile, as the command line takes it: `tg personal chats list`.
  let index = isCommandWord(program, rest[0]) || !isProfileWord(rest[0]) ? 0 : 1
  for (; index < rest.length; index++) {
    const next = at.commands.find((one) => one.name() === rest[index] || one.aliases().includes(rest[index] ?? ""))
    if (!next) break
    chain.unshift(next)
    at = next
  }
  // A mistyped command reads like a profile word; when nothing follows that is a command, name the first word.
  if (at === program) return [`no command "${rest[0] ?? ""}"`]
  const help = (at as unknown as { _getHelpOption: () => Option | null })._getHelpOption()
  const beforeDashes = rest.slice(index, rest.includes("--") ? rest.indexOf("--") : undefined)
  if (help && beforeDashes.some((word) => word === help.long || word === help.short)) return []
  if (at.commands.length > 0) return [`needs one of: ${at.commands.map((one) => one.name()).join(", ")}`]
  for (const command of chain) silent(command)
  const problems: string[] = []
  const operands: string[] = []
  const left = rest.slice(index)
  for (let word = 0; word < left.length; word++) {
    const token = left[word] as string
    if (token === "--") {
      operands.push(...left.slice(word + 1))
      break
    }
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      operands.push(token)
      continue
    }
    const flag = token.split("=")[0] as string
    const found = ownerOf(chain, flag)
    if (!found) {
      problems.push(`no option ${flag}`)
      continue
    }
    const tokens = [token]
    const takes = found.option.required || found.option.optional
    if (takes && !token.includes("=")) {
      while (left[word + 1] !== undefined && !(left[word + 1] as string).startsWith("-")) {
        tokens.push(left[++word] as string)
        if (!found.option.variadic) break
      }
      if (found.option.required && tokens.length === 1) {
        problems.push(`${flag} needs a value`)
        continue
      }
    }
    try {
      found.owner.parseOptions(tokens)
    } catch (error) {
      problems.push(`${flag}: ${error instanceof Error ? error.message.replace(/^error: /, "") : String(error)}`)
    }
  }
  for (const option of at.options)
    if (option.mandatory && at.getOptionValue(option.attributeName()) === undefined)
      problems.push(`${option.long ?? option.flags} is required`)
  const declared = at.registeredArguments
  const required = declared.filter((one) => one.required).length
  const unbounded = declared.at(-1)?.variadic === true
  if (operands.length < required)
    problems.push(
      `needs ${declared
        .filter((one) => one.required)
        .map((one) => `<${one.name()}>`)
        .join(" ")}`,
    )
  if (!unbounded && operands.length > declared.length)
    problems.push(`takes ${declared.length} argument(s), got ${operands.length}: ${operands.join(" ")}`)
  declared.forEach((argument, position) => {
    const value = operands[position]
    if (value !== undefined && argument.argChoices && !argument.argChoices.includes(value))
      problems.push(`<${argument.name()}> is one of ${argument.argChoices.join(", ")}, not ${value}`)
  })
  return problems
}

const covered = (files: readonly string[], path: string) =>
  files.some((entry) => {
    const plain = entry.replace(/(\/\*\*?)?(\/\*)?\/?$/, "").replace(/^\.\//, "")
    return path === plain || path.startsWith(`${plain}/`)
  })

/**
 * For a tool's CI: every scenario file parses, and each step's command exists and its options and arguments parse
 * on a program built fresh per step — no account, no network, no action runs. With `packageRoot`, the scenario
 * directory must also be in the package's `files`, so it ships. Returns the problems; empty means sound.
 */
export const checkGuide = async (
  build: () => Command,
  { packageRoot }: { packageRoot?: string } = {},
): Promise<string[]> => {
  const guide = build().commands.find((one) => one.name() === "guide")
  const options = guide ? guides.get(guide) : undefined
  if (!options) return ["the program has no guideCommand"]
  const { scenarios, problems } = await loadScenarios(options.directory)
  for (const scenario of scenarios)
    scenario.steps.forEach((step, index) => {
      for (const problem of [...shellProblems(step.run), ...checkStep(build(), step.run)])
        problems.push(`${scenario.name}.md step ${index + 1} (${step.run}): ${problem}`)
    })
  for (const reference of options.worksWith ?? [])
    if (!NAME.test(reference.name) || !text(reference.tool) || !text(reference.title))
      problems.push(`works with ${reference.tool} ${reference.name}: needs tool, a lower-case name and a title`)
  if (packageRoot !== undefined) {
    const path = relative(resolve(packageRoot), resolve(options.directory)).split(sep).join("/")
    const files = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files?: string[] }).files
    if (files !== undefined && !covered(files, path)) problems.push(`package.json files leaves out ${path}`)
  }
  return problems
}
