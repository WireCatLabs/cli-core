import * as v from "valibot"

export type ConfigIssueKind =
  | "invalid_json"
  | "unknown_setting"
  | "unknown_permission"
  | "missing_setting"
  | "invalid_value"

/** One problem in a config file, as `doctor` reports it. `what` never quotes a value: a secret may be pasted anywhere. */
export interface ConfigIssue {
  kind: ConfigIssueKind
  file: string
  profile?: string
  key?: string
  line?: number
  column?: number
  what: string
  fix?: string
}

/** An issue with the path in the file that `config unset` removes, which the loader drops too. */
export interface LocatedIssue extends ConfigIssue {
  at: string[]
}

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)

const SECTIONS = ["personal", "bot"] as const

const SHELL_SAFE = /^[A-Za-z0-9_.:@-]*$/

/** Where a path of the file sits: the profile and the flags `config unset` needs, and the setting under it. */
const scopeOf = (at: readonly string[]) => {
  const [first, second, third] = at
  if (first === "profiles" && second !== undefined && at.length > 2)
    return { profile: second, flags: "", rest: at.slice(2) }
  if (first === "defaults" && at.length > 1) return { flags: " --defaults", rest: at.slice(1) }
  if ((SECTIONS as readonly (string | undefined)[]).includes(first)) {
    if (second === "profiles" && third !== undefined && at.length > 3)
      return { profile: third, flags: ` --${first}`, rest: at.slice(3) }
    if (second === "defaults" && at.length > 2) return { flags: ` --defaults --${first}`, rest: at.slice(2) }
  }
  return { flags: "", rest: [...at] }
}

/** The part of a scope's path `config unset` takes as one setting: a permission key, a model field, or the setting. */
const settingPath = (rest: readonly string[]): string[] => {
  if (rest[0] === "permissions" && rest.length > 1) return rest.slice(0, 2)
  if (rest[0] === "models" && rest.length > 1) return rest.slice(0, 3)
  return rest.slice(0, 1)
}

const settingOf = (path: readonly string[]): string =>
  path[0] === "permissions" && path.length > 1 ? `permissions.${path[1]}` : path.join(".")

/** An issue at `at`, cut to the setting `config unset` removes, with that command as its fix. */
export const locate = (
  kind: ConfigIssueKind,
  at: readonly string[],
  context: { file: string; tool: string },
  what: (key: string) => string,
): LocatedIssue => {
  const { profile, flags, rest } = scopeOf(at)
  const inScope = rest.length < at.length
  // Outside a section the path itself is the key: `profiles.work` with the wrong type is removed alone.
  const setting = inScope ? settingPath(rest) : [...rest]
  const key = inScope ? settingOf(setting) : setting.join(".")
  const prefix = at.slice(0, at.length - rest.length)
  return {
    kind,
    file: context.file,
    ...(profile === undefined ? {} : { profile }),
    key,
    what: what(key),
    // A fix runs exactly as written; a name a shell would split or expand gets none.
    ...([key, profile ?? ""].every((word) => SHELL_SAFE.test(word))
      ? { fix: `${context.tool}${profile === undefined ? "" : ` ${profile}`} config unset${flags} ${key}` }
      : {}),
    at: [...prefix, ...setting],
  }
}

/**
 * Where parsing stops, found by walking the JSON grammar: V8 names no position for "Unexpected token" or
 * "Unexpected end of JSON input", and Bun names none at all. Where V8 does name one, this is the same offset.
 */
const failureOffset = (text: string): number => {
  let at = 0
  const fail = (): never => {
    throw at
  }
  const space = () => {
    while (/[ \t\n\r]/.test(text[at] ?? "")) at++
  }
  const expect = (char: string) => {
    space()
    if (text[at] !== char) fail()
    at++
  }
  const string = () => {
    expect('"')
    while (text[at] !== '"') {
      if (at >= text.length || text.charCodeAt(at) < 0x20) fail()
      at += text[at] === "\\" ? 2 : 1
    }
    at++
  }
  const items = (close: string, item: () => void) => {
    at++
    space()
    if (text[at] === close) {
      at++
      return
    }
    for (;;) {
      item()
      space()
      if (text[at] === close) break
      expect(",")
    }
    at++
  }
  const value = (): void => {
    space()
    const char = text[at] ?? ""
    if (char === "{")
      items("}", () => {
        string()
        expect(":")
        value()
      })
    else if (char === "[") items("]", value)
    else if (char === '"') string()
    else {
      const word = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(at))
      if (!word) fail()
      at += word?.[0].length ?? 0
    }
  }
  try {
    value()
    space()
    return at
  } catch (stopped) {
    return typeof stopped === "number" ? stopped : at
  }
}

/** The file's JSON, or the one issue that says where it stopped parsing. */
export const parseConfigText = (text: string, file: string): { raw: unknown } | { issue: LocatedIssue } => {
  try {
    return { raw: JSON.parse(text) }
  } catch {
    const before = text.slice(0, failureOffset(text)).split("\n")
    const line = before.length
    const column = (before.at(-1)?.length ?? 0) + 1
    return {
      issue: {
        kind: "invalid_json",
        file,
        line,
        column,
        what: `the file is not valid JSON at line ${line}, column ${column}`,
        at: [],
      },
    }
  }
}

const keyOfPath = (issue: v.BaseIssue<unknown>): string[] => (issue.path ?? []).map((item) => String(item.key))

/** A key the schema does not know: valibot says it expected nothing there. */
const isUnknownKey = (issue: v.BaseIssue<unknown>) => issue.expected === "never"

/** A `permissions` key refused by its pattern, rather than its level. */
const isPermissionKey = (issue: v.BaseIssue<unknown>, at: readonly string[]) => {
  const last = issue.path?.at(-1)
  return at.at(-2) === "permissions" && last !== undefined && "origin" in last && last.origin === "key"
}

const isMissing = (issue: v.BaseIssue<unknown>) => {
  const last = issue.path?.at(-1)
  return last !== undefined && "origin" in last && last.origin === "key" && issue.input === undefined
}

/**
 * What a value has to be, never what it was: the schema's own "has to be …" without its ", not <value>", else
 * the type or choices valibot expected.
 */
const ruleOf = (issue: v.BaseIssue<unknown>): string => {
  const own = /^(has to be [\s\S]*?)(, not [\s\S]*)?$/.exec(issue.message)
  if (own?.[1]) return own[1]
  if (issue.type === "picklist") return `has to be one of ${issue.expected}`
  // valibot's own messages start "Invalid" and quote the value; a schema's own words do not.
  if (!issue.message.startsWith("Invalid ")) return `is refused: ${issue.message}`
  if (issue.kind === "schema") return `has to be of type ${issue.expected}`
  return issue.expected === null ? "has a value it does not take" : `has to be ${issue.expected}`
}

/** One pass of the schema: valibot names only the first unknown key of each object. */
const onePass = (raw: unknown, schema: v.GenericSchema, context: { file: string; tool: string }): LocatedIssue[] => {
  const result = v.safeParse(schema, raw)
  if (result.success) return []
  return result.issues.map((issue) => {
    const at = keyOfPath(issue)
    const located = isPermissionKey(issue, at)
      ? locate("unknown_permission", at, context, (key) => `${key} names no command`)
      : isUnknownKey(issue)
        ? locate("unknown_setting", at, context, (key) => `setting ${key} is not a setting of ${context.tool}`)
        : isMissing(issue)
          ? locate("missing_setting", at, context, (key) => `setting ${key} is missing`)
          : locate("invalid_value", at, context, (key) =>
              at.length === 0 ? "the file has to be an object, in braces" : `setting ${key} ${ruleOf(issue)}`,
            )
    if (located.kind === "missing_setting" || at.length === 0) delete located.fix
    return located
  })
}

/** Every problem the schema finds, never only the first, each cut to the setting that holds it. */
export const schemaIssues = (
  raw: unknown,
  schema: v.GenericSchema,
  context: { file: string; tool: string },
): LocatedIssue[] => {
  const found = new Map<string, LocatedIssue>()
  for (;;) {
    const fresh = onePass(withoutIssues(raw, [...found.values()]), schema, context).filter(
      (issue) => !found.has(issue.at.join("\u0000")),
    )
    if (fresh.length === 0) return [...found.values()]
    for (const issue of fresh) found.set(issue.at.join("\u0000"), issue)
    // A missing setting cannot be removed, so another pass would find it again.
    if (fresh.every((issue) => issue.kind === "missing_setting" || issue.at.length === 0)) return [...found.values()]
  }
}

/** Every section of the file that may hold `permissions`, with its path. */
const scopes = (raw: unknown): [string[], Node][] => {
  if (!isNode(raw)) return []
  const out: [string[], Node][] = []
  const add = (path: string[], node: unknown) => {
    if (isNode(node)) out.push([path, node])
  }
  const addSection = (path: string[], section: unknown) => {
    if (!isNode(section)) return
    add([...path, "defaults"], section.defaults)
    if (isNode(section.profiles))
      for (const [name, scope] of Object.entries(section.profiles)) add([...path, "profiles", name], scope)
  }
  // A flat file keeps `permissions` at the top; a file with profiles has none there once its schema has run.
  add([], raw)
  addSection([], raw)
  for (const name of SECTIONS) addSection([name], raw[name])
  return out
}

/** Every saved permission key, in every section and profile of the file — not only the ones that win. */
export const savedPermissionKeys = (raw: unknown): { key: string; at: string[] }[] =>
  scopes(raw).flatMap(([path, scope]) =>
    isNode(scope.permissions)
      ? Object.keys(scope.permissions).map((key) => ({ key, at: [...path, "permissions", key] }))
      : [],
  )

/** A saved key no command checks would do nothing (BUG-137): one issue per key, wherever it is saved. */
export const permissionIssues = (
  saved: readonly { key: string; at: readonly string[] }[],
  known: ReadonlySet<string>,
  context: { file: string; tool: string },
): LocatedIssue[] =>
  saved
    .filter(({ key }) => !known.has(key))
    .map(({ at }) => locate("unknown_permission", at, context, (key) => `${key} names no command`))

/** The file without the settings the issues name: what still loads, and what `config unset` would leave. */
export const withoutIssues = (raw: unknown, issues: readonly LocatedIssue[]): unknown => {
  if (issues.some((issue) => issue.at.length === 0)) return {}
  const copy = structuredClone(raw)
  for (const { at } of issues) {
    const parent = at.slice(0, -1).reduce<unknown>((node, key) => (isNode(node) ? node[key] : undefined), copy)
    if (isNode(parent)) delete parent[at.at(-1) as string]
  }
  return copy
}

/** The public shape: where in the file is the loader's own business. */
export const publicIssue = ({ at: _, ...issue }: LocatedIssue): ConfigIssue => issue

/**
 * One line for a command that refuses to run on the file: the first problem, how to fix it, and how many more.
 * `doctor` is the command that lists them all, as the reader types it.
 */
export const issueMessage = (issues: readonly ConfigIssue[], doctor = "doctor"): string => {
  const [first] = issues
  if (!first) return ""
  const more = issues.length - 1
  return (
    `${first.file}: ${first.what}` +
    (first.fix ? ` — remove it with \`${first.fix}\`` : "") +
    (more === 0 ? "" : ` (and ${more} more problem${more === 1 ? "" : "s"} — \`${doctor}\` lists them all)`)
  )
}

/**
 * Every problem in a config file's text, and what of it still loads. Works for a file with profiles and sections
 * and for a flat one: a fix names the profile and section flags only where the path has them. With
 * `knownPermissions` (from `knownPermissionKeys`), each saved permission key outside it is an issue too, in every
 * section.
 */
export const checkConfigText = <T extends v.GenericSchema>(
  text: string,
  {
    file,
    tool,
    schema,
    knownPermissions,
  }: { file: string; tool: string; schema: T; knownPermissions?: ReadonlySet<string> },
): { issues: ConfigIssue[]; config: v.InferOutput<T> | undefined } => {
  const parsed = parseConfigText(text, file)
  if ("issue" in parsed) return { issues: [publicIssue(parsed.issue)], config: undefined }
  const context = { file, tool }
  const located = schemaIssues(parsed.raw, schema, context)
  const loaded = v.safeParse(schema, withoutIssues(parsed.raw, located))
  const config = loaded.success ? loaded.output : undefined
  const unknown = knownPermissions ? permissionIssues(savedPermissionKeys(config), knownPermissions, context) : []
  return { issues: [...located, ...unknown].map(publicIssue), config }
}
