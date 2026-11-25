import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { domainListsDirectory, type InstalledPack, installedPack, listFile } from "../domain/domain-lists.js"
import type { AppIdentity } from "../ports/app.js"
import { updateDomainLists } from "../services/domain-lists-download.js"
import type { Fetch } from "../speech/install.js"
import { stepLines } from "../terminal/step-lines.js"
import { FETCH, LOCAL_READ, NO_EFFECTS } from "./effects.js"
import { type Body, listOf } from "./envelope.js"
import { downloadProgress } from "./model-catalogue-command.js"

export interface DomainListsCommandOptions {
  env: () => NodeJS.ProcessEnv
  output: (answer: Body, command: Command) => void
  diagnostic: (line: string) => void
  offline?: () => boolean
  fetch?: Fetch
}

const itemsOf = (pack: InstalledPack | undefined, env: NodeJS.ProcessEnv) =>
  pack === undefined
    ? []
    : pack.sources.flatMap((source) => {
        const file = pack.files[source.id]
        if (file === undefined) return []
        return [
          {
            id: source.id,
            title: source.title,
            signal: source.signal,
            class: source.class,
            licence: source.licence,
            licence_url: source.licence_url,
            attribution: source.attribution,
            homepage: source.homepage,
            upstream: source.upstream === true,
            lines: file.lines,
            tags: source.tags ?? {},
            version: pack.version,
            installed_at: pack.installed_at,
            sha256: file.sha256,
            path: listFile(domainListsDirectory(env), source.id),
          },
        ]
      })

/**
 * `domain-lists`: the pack of bank, shop, news and spam lists matched against sender domains on this computer, kept
 * apart from the package so it updates without a release. Downloaded like a model: whole, checked by sha256.
 */
export const domainListsCommand = (app: AppIdentity, options: DomainListsCommandOptions): Command => {
  const lists = annotate(new Command("domain-lists"), { effects: NO_EFFECTS }).description(
    "lists of bank, shop, news and spam domains that give organizations their sector, matched on this computer",
  )
  annotate(lists.command("list"), {
    effects: LOCAL_READ,
    output: { entity: "domain_list" },
    examples: [`${app.command} domain-lists list`],
  })
    .description("the lists downloaded here, with their licence, licence class and size")
    .option("--json", "print JSON")
    .action(function (this: Command) {
      const env = options.env()
      const items = itemsOf(installedPack(env), env)
      if (items.length === 0)
        options.diagnostic(`no domain lists yet: \`${app.command} domain-lists update\` downloads them`)
      options.output(listOf("domain-lists list", { items, limit: Math.max(1, items.length), has_more: false }), this)
    })
  annotate(lists.command("update"), {
    effects: FETCH,
    output: { entity: "domain_list" },
    examples: [`${app.command} domain-lists update`, `${app.command} domain-lists update --commercial-only`],
  })
    .description(
      "download the newest pack from WireCat's GitHub release, each file checked by sha256; lists that may not be " +
        "redistributed come whole from their own source. No sender is ever sent anywhere",
    )
    .option("--commercial-only", "leave out lists whose terms forbid commercial use, and remove those already here")
    .option("--offline", "refuse a download that needs the network")
    .option("--json", "print JSON")
    .action(async function (this: Command, given: { commercialOnly?: boolean }) {
      if (options.offline?.() || this.optsWithGlobals<{ offline?: boolean }>().offline)
        throw new CliError("permission_error", "updating the domain lists needs the network; --offline was requested", {
          reason: "domain-lists.offline",
        })
      const env = options.env()
      const bytes = downloadProgress(
        stepLines(options.diagnostic, Boolean(this.optsWithGlobals<{ json?: unknown }>().json)),
        "domain-lists",
      )
      const done = await updateDomainLists({
        env,
        commercialOnly: given.commercialOnly === true,
        progress: options.diagnostic,
        bytes,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
      options.diagnostic(
        done.updated
          ? `domain lists ${done.pack.version} in place${done.previous ? ` (was ${done.previous})` : ""}; ` +
              "organizations take their sectors from them the next time a sync sorts a new sender"
          : `domain lists ${done.pack.version} are already the newest`,
      )
      const items = itemsOf(done.pack, env)
      options.output(listOf("domain-lists update", { items, limit: Math.max(1, items.length), has_more: false }), this)
    })
  return lists
}
