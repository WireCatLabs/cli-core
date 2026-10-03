import type { ApiModel, ApiOperation, Binding, CodeGenerator, Confidence, Effect, SchemaNode } from "./model.js"
import { kebab } from "./names.js"
import { SchemaTree } from "./tree.js"

/** One operation as a CLI reads it at run time: enough to build a command, validate input and guard a write. */
export interface ManifestOperation {
  id: string
  command: string
  binding: Binding
  effect: Effect
  summary?: string
  description?: string
  tags: readonly string[]
  deprecated?: boolean
  parameters: readonly {
    name: string
    in: "path" | "query" | "header" | "body"
    required: boolean
    description?: string
    schema: SchemaNode
  }[]
  request?: { required: boolean; confidence: Confidence; schema?: string }
  response?: { confidence: Confidence; schema?: string }
}

const withoutUndefined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

const toManifest = (operation: ApiOperation, tree: SchemaTree): ManifestOperation =>
  withoutUndefined({
    id: operation.id,
    command: kebab(operation.id),
    binding: operation.binding,
    effect: operation.effect as Effect,
    summary: operation.summary,
    description: operation.description,
    tags: operation.tags,
    deprecated: operation.deprecated,
    parameters: operation.parameters.map((parameter) => withoutUndefined({ ...parameter })),
    request: operation.requestBody
      ? withoutUndefined({
          required: operation.requestBody.required,
          confidence: operation.requestBody.confidence,
          schema: tree.requestName(operation.id),
        })
      : undefined,
    response: operation.response
      ? withoutUndefined({ confidence: operation.response.confidence, schema: tree.responseName(operation.id) })
      : undefined,
  })

export const manifestGenerator =
  (options: { path: string; coreImport?: string }): CodeGenerator =>
  (model: ApiModel) => {
    const tree = new SchemaTree(model)
    const operations = model.operations.map((operation) => toManifest(operation, tree))
    const content = [
      `import type { ManifestOperation } from "${options.coreImport ?? "@leemour/cli-core/codegen"}"`,
      "",
      `export const operations: readonly ManifestOperation[] = ${JSON.stringify(operations, null, 2)}`,
      "",
    ].join("\n")
    return [{ path: options.path, content }]
  }

export const definitionsGenerator =
  (options: { path: string; coreImport?: string }): CodeGenerator =>
  (model: ApiModel) => {
    const tree = new SchemaTree(model)
    const definitions = Object.fromEntries(tree.named.map(({ name, schema }) => [name, schema.schema]))
    return [
      {
        path: options.path,
        content: `import type { SchemaNode } from "${options.coreImport ?? "@leemour/cli-core/codegen"}"\n\nexport const definitions: Readonly<Record<string, SchemaNode>> = ${JSON.stringify(definitions, null, 2)}\n`,
      },
    ]
  }

const cell = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()

export interface CoverageOptions {
  path: string
  title: string
  /** How a user reaches the operation, e.g. `max bot api get-my-info`. */
  command: (operation: ManifestOperation) => string
}

/** Every operation the source has, and how it is reached — the page a reviewer diffs after a sync. */
export const coverageGenerator =
  (options: CoverageOptions): CodeGenerator =>
  (model: ApiModel) => {
    const tree = new SchemaTree(model)
    const rows = model.operations.map((operation) => {
      const entry = toManifest(operation, tree)
      const binding =
        entry.binding.kind === "http" ? `${entry.binding.method} ${entry.binding.path}` : entry.binding.name
      const status = entry.deprecated ? "deprecated" : "generated"
      return `| \`${entry.id}\` | \`${binding}\` | \`${options.command(entry)}\` | ${entry.effect} | ${
        entry.request?.confidence ?? "—"
      } | ${status} | ${cell(entry.summary)} |`
    })
    const version = model.source.version ? ` ${model.source.version}` : ""
    const content = [
      `# ${options.title}`,
      "",
      `${model.operations.length} operations from ${model.source.kind}${version}.`,
      "",
      "| Operation | Call | Command | Effect | Request source | Status | Summary |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join("\n")
    return [{ path: options.path, content }]
  }
