import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import type { Schedule } from "../background/schedules.js"
import { httpLockFile } from "../mcp/http/state.js"
import { moderationPathFor } from "../moderation/rules.js"
import type { AppIdentity } from "../ports/app.js"
import { replyConsentPathFor } from "../replies/consents.js"
import { repliesPathFor } from "../replies/rules.js"
import { repliesStatePathFor } from "../replies/state.js"
import { providerLogPathFor } from "../runs/provider-log.js"
import { floodPathFor } from "../sends/flood.js"
import { pacePathFor } from "../sends/pace.js"
import { recipientsPathFor } from "../sends/recipients.js"

/** Where `--new` keeps its points: the owner's, an agent's over MCP, and each schedule's own (`pointsOf`). */
const pointFolders = (schedules: readonly Schedule[]): string[] => [
  "mentions",
  ...["inbox", "review"].flatMap((name) => [
    name,
    `mcp-${name}`,
    ...schedules.map(({ name: schedule }) => `schedule-${schedule.replace(/[^a-z0-9-]/gi, "_")}-${name}`),
  ]),
]

/**
 * The files cli-core itself writes for one profile, so a tool's `account remove` need not list them. The sends
 * journal is not among them: it is the record of what was sent, and it stays.
 */
export const profileFiles = (
  app: AppIdentity,
  profile: string,
  env: NodeJS.ProcessEnv,
  schedules: readonly Schedule[],
): string[] => {
  const { state } = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env })
  const tokens = join(state, "mcp-http", `${profile}.json`)
  return [
    floodPathFor(app, profile, env),
    pacePathFor(app, profile, env),
    recipientsPathFor(app, profile, env),
    moderationPathFor(app, profile, env),
    providerLogPathFor(app, profile, env),
    tokens,
    httpLockFile(tokens),
    repliesPathFor(app, profile, env),
    replyConsentPathFor(app, profile, env),
    repliesStatePathFor(app, profile, env),
    join(state, "serve", `${profile}.log`),
    join(state, "checkpoints", profile),
    ...pointFolders(schedules).map((folder) => join(state, folder, `${profile}.json`)),
  ]
}
