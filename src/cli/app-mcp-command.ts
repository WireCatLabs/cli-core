import type { Command } from "commander"
import type { AppServerOptions } from "../mcp/app-server.js"
import type { AppIdentity } from "../ports/app.js"
import { baseContext } from "./context.js"
import { type McpHost, mcpGroup } from "./messenger/mcp-command.js"
import { refuseUnknownPermissionKeys } from "./permission-keys.js"
import type { Configuration } from "./settings.js"

export interface AppMcpOptions {
  /** `Google Calendar`: what the instructions call the service. */
  name: string
  /** The kinds of text other people wrote that the answers carry: `event titles, descriptions, attendee names`. */
  untrusted: AppServerOptions["untrusted"]
  /** One of the CLI's permission keys for `--permission`'s help: `calendar.events.delete=deny`. */
  permissionExample: string
  skill?: URL
  /** What the CLI alone knows stops a command for a profile, such as an OAuth grant without the scope. */
  availability?: AppServerOptions["availability"]
  /** Whether the profile can reach the service, read from disk; left out, `mcp check` does not say. */
  signedIn?: (profile: string, env: NodeJS.ProcessEnv) => boolean
}

/**
 * `mcp serve | revoke | server | config | add | check` for a CLI that is not a messenger — the same commands, flags
 * and answers as a messenger's `mcpCommand`, with `--profiles` and `--permission`, served by the CLI's own program
 * (`createAppServer`). gcal, drive and zoom mount this instead of an `mcp` of their own.
 */
export const appMcpCommand = (app: AppIdentity, configuration: Configuration, options: AppMcpOptions): Command => {
  const server = (): AppServerOptions => ({
    app,
    name: options.name,
    untrusted: options.untrusted,
    resolveSettings: configuration.resolveSettings,
    permissions: configuration.permissions,
    ...(options.skill ? { skill: options.skill } : {}),
    ...(options.availability ? { availability: options.availability } : {}),
  })
  // `mcp serve` has no key of its own, so the shared check before a run never looks at the keys --permission names.
  const checked = (self: Command, context: ReturnType<McpHost["context"]>) =>
    refuseUnknownPermissionKeys(self, context.settings, app.command, configuration.permissions)
  const host: McpHost = {
    app,
    name: options.name,
    resolveSettings: configuration.resolveSettings,
    context: (self, given) =>
      baseContext(self, (flags, resolve) =>
        configuration.resolveSettings(flags, { ...resolve, needsProfile: given?.needsProfile ?? true }),
      ),
    permissionExample: options.permissionExample,
    serveStdio: async (self, context) => {
      checked(self, context)
      const { serveAppOverStdio } = await import("../mcp/app-server.js")
      await serveAppOverStdio(self, context, server())
    },
    serveHttp: async (self, context, http) => {
      checked(self, context)
      const { serveAppOverHttp } = await import("../mcp/app-server.js")
      await serveAppOverHttp(self, context, server(), http)
    },
    instructions: async (profiles) => {
      const { appInstructions } = await import("../mcp/instructions.js")
      return appInstructions({
        command: app.command,
        name: options.name,
        profile: profiles,
        untrusted: options.untrusted,
      })
    },
    signedIn: (_self, profile, env) => options.signedIn?.(profile, env),
  }
  return mcpGroup(host)
}
