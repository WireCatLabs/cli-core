import type { ApiModel, CodeGenerator, SchemaNode } from "./model.js"
import { identifier } from "./names.js"
import { CodegenError } from "./pipeline.js"
import { SchemaTree } from "./tree.js"

type Literal = { property: string; value: string }

const key = (name: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name))

const piped = (base: string, actions: readonly string[]): string =>
  actions.length === 0 ? base : `v.pipe(${base}, ${actions.join(", ")})`

const range = (node: { minimum?: number; maximum?: number }): string => {
  const parts: string[] = []
  if (node.minimum !== undefined) parts.push(`minimum: ${node.minimum}`)
  if (node.maximum !== undefined) parts.push(`maximum: ${node.maximum}`)
  return parts.length === 0 ? "" : `{ ${parts.join(", ")} }`
}

class SchemaWriter {
  readonly helpers = new Set<string>()

  constructor(readonly tree: SchemaTree) {}

  node(node: SchemaNode, where: string, literal?: Literal): string {
    const base = this.#bare(node, where, literal)
    return node.nullable ? `v.nullable(${base})` : base
  }

  #bare(node: SchemaNode, where: string, literal?: Literal): string {
    switch (node.type) {
      case "ref":
        return `v.lazy(() => ${identifier(node.ref)})`
      case "string": {
        if (node.enum) return `v.picklist(${JSON.stringify(node.enum)})`
        const actions: string[] = []
        if (node.minLength !== undefined) actions.push(`v.minLength(${node.minLength})`)
        if (node.maxLength !== undefined) actions.push(`v.maxLength(${node.maxLength})`)
        if (node.pattern !== undefined) {
          try {
            new RegExp(node.pattern)
          } catch {
            throw new CodegenError([`${where}: pattern ${JSON.stringify(node.pattern)} is not a JS regular expression`])
          }
          actions.push(`v.regex(new RegExp(${JSON.stringify(node.pattern)}))`)
        }
        return piped("v.string()", actions)
      }
      case "integer": {
        const helper = node.format === "int64" ? "int64" : "integer"
        this.helpers.add(helper)
        const call = `${helper}(${range(node)})`
        if (!node.enum) return call
        const values = helper === "int64" ? node.enum.map(String) : node.enum
        return piped(call, [`v.picklist(${JSON.stringify(values)})`])
      }
      case "number":
        this.helpers.add("number")
        return `number(${range(node)})`
      case "boolean":
        return "v.boolean()"
      case "unknown":
        return "v.unknown()"
      case "array": {
        const actions: string[] = []
        if (node.minItems !== undefined) actions.push(`v.minLength(${node.minItems})`)
        if (node.maxItems !== undefined) actions.push(`v.maxLength(${node.maxItems})`)
        if (node.uniqueItems) this.helpers.add("unique")
        if (node.uniqueItems) actions.push(`v.check((items) => unique(items), "items must be unique")`)
        return piped(`v.array(${this.node(node.items, `${where}[]`)})`, actions)
      }
      case "allOf":
        if (node.of.length === 1 && node.of[0] && !literal) return this.#bare(node.of[0], where)
        return this.#object(this.tree.flatten(node, where), where, literal)
      case "object":
        return this.#object(node, where, literal)
    }
  }

  // Loose on purpose: MAX adds fields, and a response with a field we have never seen is still valid.
  #object(node: Extract<SchemaNode, { type: "object" }>, where: string, literal?: Literal): string {
    const names = Object.keys(node.properties)
    if (literal && !names.includes(literal.property)) names.unshift(literal.property)
    const rest = node.additionalProperties ? this.node(node.additionalProperties, where) : undefined
    if (names.length === 0) return rest ? `v.record(v.string(), ${rest})` : "v.looseObject({})"
    const entries = names.map((name) => {
      if (literal?.property === name) return `  ${key(name)}: v.literal(${JSON.stringify(literal.value)}),`
      const property = node.properties[name] as SchemaNode
      const schema = this.node(property, `${where}.${name}`)
      return `  ${key(name)}: ${node.required.includes(name) ? schema : `v.optional(${schema})`},`
    })
    const body = `{\n${entries.join("\n")}\n}`
    return rest ? `v.objectWithRest(${body}, ${rest})` : `v.looseObject(${body})`
  }
}

export interface ValibotOptions {
  path: string
  /** Module the types come from, relative to `path`. */
  typesImport: string
  runtimeImport?: string
}

/** Valibot schemas that keep the source's constraints at run time, which plain generated types lose. */
export const valibotGenerator =
  (options: ValibotOptions): CodeGenerator =>
  (model: ApiModel) => {
    const tree = new SchemaTree(model)
    const writer = new SchemaWriter(tree)
    const declarations = tree.named.map(({ name, schema }) => {
      const expression = schema.discriminator
        ? `v.union([${Object.values(schema.discriminator.mapping)
            .map((target) => `v.lazy(() => ${identifier(target)})`)
            .join(", ")}])`
        : writer.node(schema.schema, schema.id, tree.literalFor(schema.id))
      return `export const ${name}: v.GenericSchema<unknown, T.${name}> = ${expression}\n`
    })
    const helpers = [...writer.helpers].sort()
    const runtime = options.runtimeImport ?? "@leemour/cli-core/codegen/runtime"
    const packages = [
      `import * as v from "valibot"`,
      ...(helpers.length > 0 ? [`import { ${helpers.join(", ")} } from "${runtime}"`] : []),
    ].sort((a, b) => (a.split(" from ")[1] ?? "").localeCompare(b.split(" from ")[1] ?? ""))
    const header = [...packages, `import type * as T from "${options.typesImport}"`, ""]
    const registry = `export const schemas = {\n${tree.named.map(({ name }) => `  ${name},`).join("\n")}\n} as const\n`
    return [{ path: options.path, content: `${header.join("\n")}\n${declarations.join("\n")}\n${registry}` }]
  }
