import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Command } from "commander"
import { parseDocument } from "yaml"

export interface SkillValidation {
  folder?: string
  file?: string
  version?: string
  program?: Command
}

// The Agent Skills specification asks for string values; OpenClaw and ClawHub read their install and requirement
// declarations only from an object at `metadata.openclaw`, so that one key is a mapping.
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const validateSkill = (content: string, options: SkillValidation = {}): string[] => {
  const problems: string[] = []
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return ["SKILL.md needs YAML frontmatter"]
  const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true })
  if (yaml.errors.length) return ["SKILL.md frontmatter is not valid YAML"]
  let data: unknown
  try {
    data = yaml.toJS({ maxAliasCount: 0 })
  } catch {
    return ["SKILL.md frontmatter cannot be read"]
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["SKILL.md frontmatter must be an object"]
  const fields = data as Record<string, unknown>
  if (typeof fields.name !== "string" || fields.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name))
    problems.push("skill name must be 1–64 lowercase letters, digits and single hyphens")
  if (options.folder && fields.name !== options.folder) problems.push("skill name must match its folder")
  if (typeof fields.description !== "string" || !fields.description.trim() || fields.description.length > 1024)
    problems.push("skill description must be 1–1024 characters")
  if (
    fields.compatibility !== undefined &&
    (typeof fields.compatibility !== "string" || fields.compatibility.length > 500)
  )
    problems.push("skill compatibility must be a string of at most 500 characters")
  for (const key of ["license", "allowed-tools"])
    if (fields[key] !== undefined && typeof fields[key] !== "string") problems.push(`skill ${key} must be a string`)
  const known = new Set(["name", "description", "license", "compatibility", "allowed-tools", "metadata"])
  for (const key of Object.keys(fields)) if (!known.has(key)) problems.push(`unsupported frontmatter field: ${key}`)
  if (
    fields.metadata !== undefined &&
    (!isMap(fields.metadata) ||
      Object.entries(fields.metadata).some(([key, value]) =>
        key === "openclaw" ? !isMap(value) : typeof value !== "string",
      ))
  )
    problems.push("skill metadata must contain string values, and metadata.openclaw a mapping")
  if (options.version && (fields.metadata as Record<string, unknown> | undefined)?.version !== options.version)
    problems.push("emitted skill version must match the binary")

  const body = content.slice(match[0].length)
  if (options.file) {
    for (const link of body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = (link[1] ?? "").split("#")[0] ?? ""
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue
      if (!existsSync(resolve(dirname(options.file), target))) problems.push(`missing skill reference: ${target}`)
    }
  }
  if (options.program) {
    const root = options.program
    const spans = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]*(?:\n[^`\n]*)?)`/g)]
    for (const span of spans) {
      const text = span[1] ?? span[2] ?? ""
      const escaped = root.name().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      for (const call of text.matchAll(
        new RegExp(`(?:^|[\\s;])(?:${escaped}|\\{\\{command\\}\\})\\s+([^\\n;]+)`, "g"),
      )) {
        const tokens = (call[1] ?? "").trim().split(/\s+/)
        let at = root
        let start = 0
        if (
          !root.commands.some((child) => child.name() === tokens[0]) &&
          root.commands.some((child) => child.name() === tokens[1])
        )
          start = 1
        for (const word of tokens.slice(start)) {
          if (!/^[a-z][a-z-]*$/.test(word)) break
          const child = at.commands.find((one) => one.name() === word || one.aliases().includes(word))
          if (child) {
            at = child
            continue
          }
          if ((at.registeredArguments.length === 0 && at.commands.length > 0) || at === root)
            problems.push(`unknown skill command path: ${[root.name(), ...tokens.slice(start)].join(" ")}`)
          break
        }
      }
    }
  }
  return [...new Set(problems)]
}
