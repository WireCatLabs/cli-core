/**
 * A scalar setting a CLI writes into its config file with its default, so the owner finds and edits it there without
 * reading the docs (WC-CMD-30). Never declare a secret: `config show` prints every declared value.
 */
export interface DeclaredSetting {
  /** The dotted path in the file. A nested setting is written only where its section already exists. */
  key: string
  default: string | number | boolean
  description: string
}

export interface SettingRow {
  setting: string
  value: unknown
  default: string | number | boolean
  from: "config file" | "default"
  description: string
}

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)

const parentOf = (config: Node, key: string): { node: unknown; leaf: string } => {
  const path = key.split(".")
  const leaf = path.pop() as string
  return { node: path.reduce<unknown>((node, part) => (isNode(node) ? node[part] : undefined), config), leaf }
}

/**
 * The file with every declared setting it lacks, at its default. What the owner wrote stays as written, in its order,
 * unknown keys included; a section that is not there is not created, since it may need fields no default can give.
 */
export const withSettingDefaults = (
  raw: unknown,
  declared: readonly DeclaredSetting[],
): { config: unknown; added: string[] } => {
  if (raw !== undefined && !isNode(raw)) return { config: raw, added: [] }
  const config: Node = raw === undefined ? {} : structuredClone(raw)
  const added: string[] = []
  for (const setting of declared) {
    const { node, leaf } = parentOf(config, setting.key)
    if (!isNode(node) || Object.hasOwn(node, leaf)) continue
    node[leaf] = setting.default
    added.push(setting.key)
  }
  return { config, added }
}

/** Every declared setting with what holds and whether the file says it, for `config show`. */
export const settingRows = (raw: unknown, declared: readonly DeclaredSetting[]): SettingRow[] =>
  declared.map((setting) => {
    const { node, leaf } = isNode(raw) ? parentOf(raw, setting.key) : { node: undefined, leaf: "" }
    const written = isNode(node) && Object.hasOwn(node, leaf)
    return {
      setting: setting.key,
      value: written ? node[leaf] : setting.default,
      default: setting.default,
      from: written ? "config file" : "default",
      description: setting.description,
    }
  })
