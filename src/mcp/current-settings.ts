import { readFileSync } from "node:fs"
import type { Settings } from "../cli/settings.js"
import { storePath } from "../store/path.js"
import { sharedConfigPath } from "../store/shared-config.js"

const textOf = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

/**
 * The settings an open MCP server checks each call against, resolved again only when the text of a file its
 * permissions come from changed: the CLI's config file and the machine's shared one (`setup`'s ceiling). Resolving
 * them all reads the ancestors' environments and every profile's folders, a third of the CPU of a tool call. The key
 * is the text, not the time it changed, so an edit within the same tick of the file's clock still applies at once.
 */
export const whileUnchanged = <S extends Pick<Settings, "configPath">>(
  settings: Pick<Settings, "configPath">,
  env: NodeJS.ProcessEnv,
  resolve: () => S,
): (() => S) => {
  const files = [settings.configPath, sharedConfigPath(storePath(env), env)]
  let last: { key: string; value: S } | undefined
  return () => {
    const key = JSON.stringify(files.map(textOf))
    if (last?.key === key) return last.value
    const value = resolve()
    // Keep it only when it read the file the key watched; otherwise watch that file from the next call on.
    if (value.configPath === files[0]) last = { key, value }
    else {
      files[0] = value.configPath
      last = undefined
    }
    return value
  }
}
