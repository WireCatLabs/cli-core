import { createRequire } from "node:module"

const require = createRequire(`${process.argv[2]}/package.json`)
const api = await import(require.resolve("@wirecat/cli-core/services"))
if (!Array.isArray(api.QUERY_FIELDS) || typeof api.QUERY_VERSION !== "number")
  throw new Error("pinned package has no declared query profile exports")
console.log(
  JSON.stringify(
    {
      queryVersion: api.QUERY_VERSION,
      fieldVersion: api.FIELD_VERSION,
      fields: api.QUERY_FIELDS,
      operators: api.QUERY_OPERATORS,
      limits: api.QUERY_LIMITS,
    },
    null,
    2,
  ),
)
