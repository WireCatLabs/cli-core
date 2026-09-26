import type { ApiModel, CodeGenerator, SchemaNode } from "./model.js"
import { identifier, SchemaTree } from "./tree.js"

const doc = (text: string | undefined, indent: string): string => {
  const line = text?.replace(/\s+/g, " ").replace(/\*\//g, "*\\/").trim()
  return line ? `${indent}/** ${line} */\n` : ""
}

const key = (name: string): string => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name))

class TypeWriter {
  constructor(readonly tree: SchemaTree) {}

  node(node: SchemaNode, where: string, literal?: { property: string; value: string }): string {
    const base = this.#bare(node, where, literal)
    return node.nullable ? `${base} | null` : base
  }

  #bare(node: SchemaNode, where: string, literal?: { property: string; value: string }): string {
    switch (node.type) {
      case "ref":
        return identifier(node.ref)
      case "string":
        return node.enum ? node.enum.map((value) => JSON.stringify(value)).join(" | ") : "string"
      case "integer":
        if (node.format === "int64") return "string"
        return node.enum ? node.enum.map(String).join(" | ") : "number"
      case "number":
        return "number"
      case "boolean":
        return "boolean"
      case "unknown":
        return "unknown"
      case "array": {
        return `Array<${this.node(node.items, `${where}[]`)}>`
      }
      case "allOf":
        if (node.of.length === 1 && node.of[0]) return this.#bare(node.of[0], where)
        return this.#object(this.tree.flatten(node, where), where, literal)
      case "object":
        return this.#object(node, where, literal)
    }
  }

  #object(
    node: Extract<SchemaNode, { type: "object" }>,
    where: string,
    literal?: { property: string; value: string },
  ): string {
    const names = Object.keys(node.properties)
    if (literal && !names.includes(literal.property)) names.unshift(literal.property)
    const rest = node.additionalProperties
      ? `Record<string, ${this.node(node.additionalProperties, where)}>`
      : undefined
    if (names.length === 0) return rest ?? "Record<string, unknown>"
    const fields = names.map((name) => {
      const property: SchemaNode = node.properties[name] ?? { type: "string" }
      const optional = node.required.includes(name) || literal?.property === name ? "" : "?"
      const type = literal?.property === name ? JSON.stringify(literal.value) : this.node(property, `${where}.${name}`)
      return `${doc(property.description, "  ")}  ${key(name)}${optional}: ${type}`
    })
    const body = `{\n${fields.join("\n")}\n}`
    return rest ? `${body} & ${rest}` : body
  }
}

/** TypeScript types for every schema: what a caller holds after the response has been validated. */
export const typesGenerator =
  (options: { path: string }): CodeGenerator =>
  (model: ApiModel) => {
    const tree = new SchemaTree(model)
    const writer = new TypeWriter(tree)
    const declarations = tree.named.map(({ name, schema }) => {
      const union = schema.discriminator
        ? Object.values(schema.discriminator.mapping).map(identifier).join(" | ")
        : undefined
      const type = union ?? writer.node(schema.schema, schema.id, tree.literalFor(schema.id))
      return `${doc(schema.schema.description, "")}export type ${name} = ${type}\n`
    })
    return [{ path: options.path, content: declarations.join("\n") }]
  }
