import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as v from "valibot"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type ApiModel,
  definitionsGenerator,
  generate,
  manifestGenerator,
  typesGenerator,
  valibotGenerator,
  validateModel,
} from "./index.js"

const model: ApiModel = {
  source: { kind: "other" },
  schemas: [
    { id: "Address", schema: { type: "union", of: [{ type: "integer", format: "int64" }, { type: "string" }] } },
    { id: "File", schema: { type: "string", format: "binary", sensitive: true } },
    {
      id: "Node",
      schema: {
        type: "union",
        of: [
          { type: "string" },
          {
            type: "object",
            properties: { next: { type: "ref", ref: "Node" }, ready: { type: "boolean", enum: [true] } },
            required: ["ready"],
          },
        ],
      },
    },
  ],
  operations: [
    {
      id: "readNode",
      binding: { kind: "rpc", name: "readNode" },
      tags: [],
      parameters: [{ name: "address", in: "body", required: true, schema: { type: "ref", ref: "Address" } }],
      response: { required: true, confidence: "contract", schema: { type: "ref", ref: "Node", sensitive: true } },
      effect: "read",
      source: { location: "methods/readNode" },
    },
  ],
}

describe("generated unions", () => {
  let root: string
  let schemas: Record<string, v.GenericSchema>

  beforeAll(async () => {
    root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".tmp-unions-"))
    for (const artifact of generate(
      model,
      [
        typesGenerator({ path: "types.ts" }),
        valibotGenerator({ path: "schemas.ts", typesImport: "./types.js", runtimeImport: "../runtime.js" }),
        manifestGenerator({ path: "manifest.ts", coreImport: "../index.js" }),
        definitionsGenerator({ path: "definitions.ts", coreImport: "../index.js" }),
      ],
      { banner: ["synthetic union contract"] },
    ))
      writeFileSync(join(root, artifact.path), artifact.content)
    ;({ schemas } = await import(join(root, "schemas.ts")))
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it("compiles recursive alternatives, Boolean literals and RPC body parameters together", () => {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        extends: "../../../tsconfig.json",
        compilerOptions: {
          noEmit: true,
          composite: false,
          declaration: false,
          declarationMap: false,
          rootDir: "../..",
        },
        include: ["*.ts"],
      }),
    )
    const tsc = join(root, "../../../node_modules/.bin", process.platform === "win32" ? "tsc.cmd" : "tsc")
    expect(() => execFileSync(tsc, ["-p", join(root, "tsconfig.json")], { stdio: "pipe" })).not.toThrow()
  }, 30_000)

  it("preserves large integers and accepts each alternative while rejecting wrong literals", () => {
    const address = schemas.Address as v.GenericSchema
    expect(v.parse(address, { isLosslessNumber: true, value: "9007199254740993" })).toBe("9007199254740993")
    expect(v.parse(address, "@example")).toBe("@example")
    expect(v.safeParse(address, false).success).toBe(false)
    const node = schemas.Node as v.GenericSchema
    expect(v.safeParse(node, { ready: true, next: { ready: true, next: "end" } }).success).toBe(true)
    expect(v.safeParse(node, { ready: false }).success).toBe(false)
    const file = schemas.File as v.GenericSchema
    expect(v.safeParse(file, "attach://photo").success).toBe(true)
    expect(v.safeParse(file, "local-path").success).toBe(false)
  })

  it("emits runtime definitions with source formats and resolves response references", async () => {
    const { definitions } = await import(join(root, "definitions.ts"))
    expect(definitions.File).toEqual({ type: "string", format: "binary", sensitive: true })
    const { operations } = await import(join(root, "manifest.ts"))
    expect(operations[0].response.schema).toBe("Node")
    expect(operations[0].response.sensitive).toBe(true)
    expect(definitions.Node.type).toBe("union")
  })

  it("refuses empty alternatives and missing references inside nested unions", () => {
    expect(() => validateModel({ ...model, schemas: [{ id: "Empty", schema: { type: "union", of: [] } }] })).toThrow(
      /union has no members/,
    )
    expect(() =>
      validateModel({
        ...model,
        schemas: [
          { id: "Missing", schema: { type: "array", items: { type: "union", of: [{ type: "ref", ref: "Absent" }] } } },
        ],
      }),
    ).toThrow(/unknown schema "Absent"/)
  })
})
