import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import type { ApiModel, ApiOperation, CodeGenerator, GeneratedArtifact, Override, SchemaNode } from "./model.js"
import { identifier, kebab } from "./names.js"

export class CodegenError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`generation stopped:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`)
    this.name = "CodegenError"
  }
}

export const applyOverrides = (model: ApiModel, overrides: Readonly<Record<string, Override>>): ApiModel => {
  const known = new Set(model.operations.map((operation) => operation.id))
  const stale = Object.keys(overrides).filter((id) => !known.has(id))
  if (stale.length > 0) {
    // A correction that matches nothing any more has silently stopped being applied.
    throw new CodegenError(stale.map((id) => `override "${id}" matches no operation — stale, or the id changed`))
  }
  return {
    ...model,
    operations: model.operations.map((operation) => {
      const override = overrides[operation.id]
      return override?.effect ? { ...operation, effect: override.effect } : operation
    }),
  }
}

const bindingKey = (operation: ApiOperation): string =>
  operation.binding.kind === "http"
    ? `${operation.binding.method} ${operation.binding.path}`
    : `rpc ${operation.binding.name}`

const duplicates = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort()

const refsIn = (node: SchemaNode, found: string[] = []): string[] => {
  switch (node.type) {
    case "ref":
      found.push(node.ref)
      break
    case "array":
      refsIn(node.items, found)
      break
    case "object":
      for (const property of Object.values(node.properties)) refsIn(property, found)
      if (node.additionalProperties) refsIn(node.additionalProperties, found)
      break
    case "allOf":
      for (const member of node.of) refsIn(member, found)
      break
  }
  return found
}

const mergedRefs = (node: SchemaNode): string[] => {
  if (node.type === "ref") return [node.ref]
  if (node.type === "allOf") return node.of.flatMap(mergedRefs)
  return []
}

/** Only the references an allOf merge follows: a property or an array item may point back legitimately. */
const mergeCycles = (model: ApiModel): string[] => {
  const byId = new Map(model.schemas.map((schema) => [schema.id, schema.schema]))
  const done = new Set<string>()
  const problems: string[] = []
  const visit = (id: string, path: string[]): void => {
    const at = path.indexOf(id)
    if (at >= 0) {
      problems.push(`schema "${id}" includes itself through allOf: ${[...path.slice(at), id].join(" → ")}`)
      return
    }
    const node = byId.get(id)
    if (done.has(id) || !node) return
    for (const ref of mergedRefs(node)) visit(ref, [...path, id])
    done.add(id)
  }
  for (const schema of model.schemas) visit(schema.id, [])
  return problems
}

/** Everything that would otherwise make an operation vanish or turn into a guess. */
export const validateModel = (model: ApiModel): void => {
  const problems: string[] = []
  for (const id of duplicates(model.operations.map((operation) => operation.id))) {
    problems.push(`two operations share the id "${id}"`)
  }
  for (const key of duplicates(model.operations.map(bindingKey))) problems.push(`two operations are both ${key}`)
  for (const id of duplicates(model.schemas.map((schema) => schema.id))) {
    problems.push(`two schemas share the id "${id}"`)
  }
  for (const command of duplicates(model.operations.map((operation) => kebab(operation.id)))) {
    problems.push(`two operations both become the command "${command}"`)
  }
  for (const name of duplicates(model.schemas.map((schema) => identifier(schema.id)))) {
    problems.push(`two schemas both become the name "${name}"`)
  }
  for (const operation of model.operations) {
    for (const name of duplicates(operation.parameters.map((parameter) => parameter.name))) {
      problems.push(`operation "${operation.id}" has two parameters named "${name}"`)
    }
  }
  for (const operation of model.operations) {
    if (!operation.effect) problems.push(`operation "${operation.id}" is not classified as read, write or destructive`)
  }

  const schemaIds = new Set(model.schemas.map((schema) => schema.id))
  const unresolved = (where: string, node: SchemaNode | undefined) => {
    if (!node) return
    for (const ref of refsIn(node)) if (!schemaIds.has(ref)) problems.push(`${where} refers to unknown schema "${ref}"`)
  }
  for (const schema of model.schemas) {
    unresolved(`schema "${schema.id}"`, schema.schema)
    for (const [value, target] of Object.entries(schema.discriminator?.mapping ?? {})) {
      if (!schemaIds.has(target)) problems.push(`schema "${schema.id}" maps "${value}" to unknown schema "${target}"`)
    }
  }
  for (const operation of model.operations) {
    for (const parameter of operation.parameters) unresolved(`operation "${operation.id}"`, parameter.schema)
    unresolved(`operation "${operation.id}" request`, operation.requestBody?.schema)
    unresolved(`operation "${operation.id}" response`, operation.response?.schema)
  }
  problems.push(...mergeCycles(model))
  if (problems.length > 0) throw new CodegenError(problems)
}

export interface GenerateOptions {
  overrides?: Readonly<Record<string, Override>>
  /** Lines under "GENERATED. DO NOT EDIT." — the source and the command. Nothing that changes by itself. */
  banner: readonly string[]
}

const commentFor = (path: string, lines: readonly string[]): string => {
  if (extname(path) === ".md") return `<!--\n${lines.join("\n")}\n-->\n\n`
  return `${lines.map((line) => `// ${line}`).join("\n")}\n\n`
}

export const generate = (
  model: ApiModel,
  generators: readonly CodeGenerator[],
  options: GenerateOptions,
): GeneratedArtifact[] => {
  const prepared = applyOverrides(model, options.overrides ?? {})
  validateModel(prepared)
  const artifacts = generators.flatMap((generator) => generator(prepared))
  const clashing = duplicates(artifacts.map((artifact) => artifact.path))
  if (clashing.length > 0) throw new CodegenError(clashing.map((path) => `two generators both write ${path}`))
  const banner = ["GENERATED. DO NOT EDIT.", ...options.banner]
  return artifacts.map((artifact) => ({ ...artifact, content: commentFor(artifact.path, banner) + artifact.content }))
}

export interface WriteOptions {
  root: string
  /** Compare only: report what is out of date and write nothing. */
  check?: boolean
  /** The consumer's formatter, so a check compares what would actually be committed. */
  format?: (path: string, content: string) => string
}

/** Paths whose committed content differs from what was generated — written, or with `check`, only reported. */
export const writeArtifacts = (artifacts: readonly GeneratedArtifact[], options: WriteOptions): string[] => {
  const stale: string[] = []
  for (const artifact of artifacts) {
    const target = join(options.root, artifact.path)
    const content = options.format ? options.format(artifact.path, artifact.content) : artifact.content
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined
    if (current === content) continue
    stale.push(artifact.path)
    if (options.check) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return stale
}
