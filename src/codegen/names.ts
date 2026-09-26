const pascal = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("")

// A generated `export const Error` compiles, and then every `new Error()` in that module builds a schema.
const GLOBALS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "Function",
  "Intl",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Partial",
  "Promise",
  "Proxy",
  "Record",
  "Reflect",
  "RegExp",
  "Required",
  "Set",
  "String",
  "Symbol",
  "URL",
  "WeakMap",
  "WeakSet",
])

export const identifier = (id: string): string => {
  const name = pascal(id)
  if (!/^[A-Za-z]/.test(name)) return `Schema${name}`
  return GLOBALS.has(name) ? `Api${name}` : name
}

/** `getMyInfo` → `get-my-info`. */
export const kebab = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
