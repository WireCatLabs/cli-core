import { existsSync } from "node:fs"
import { win32 } from "node:path"

const variable = (env: NodeJS.ProcessEnv, name: string) =>
  Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]

export const executableOnPath = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string => {
  if (platform !== "win32" || win32.isAbsolute(command)) return command
  if (/[\\/]/.test(command)) return command
  const extensions = win32.extname(command)
    ? [""]
    : (variable(env, "PATHEXT") ?? ".EXE;.COM;.CMD;.BAT").split(";").filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
  for (const entry of (variable(env, "PATH") ?? "").split(";")) {
    const directory = entry.replace(/^"(.*)"$/, "$1")
    for (const extension of extensions) {
      const candidate = win32.join(directory, command + extension)
      if (exists(candidate)) return candidate
    }
  }
  return command
}

export const executableEnvironment = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv => {
  if (platform !== "win32") return env
  const configured = variable(env, "COMSPEC")
  const system = variable(env, "SYSTEMROOT")
  const shell = configured
    ? configured
    : system && win32.isAbsolute(system)
      ? win32.join(system, "System32", "cmd.exe")
      : undefined
  if (!shell) return env
  const result = { ...env }
  for (const key of Object.keys(result)) if (key.toUpperCase() === "COMSPEC") delete result[key]
  result.comspec = shell
  return result
}
