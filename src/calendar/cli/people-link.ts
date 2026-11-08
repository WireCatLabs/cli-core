import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { actorOf, asOwnerOption } from "../../cli/author.js"
import { LOCAL_WRITE } from "../../cli/effects.js"
import { linkPeople } from "../../services/people.js"
import { itemBody, messagesOf } from "./bodies.js"
import type { CommandHelpers } from "./index.js"

export const addPeopleLink = (people: Command, { within, example }: Pick<CommandHelpers, "within" | "example">) =>
  example(
    annotate(people.command("link"), { effects: LOCAL_WRITE })
      .description("join an attendee to a person the owner knows elsewhere")
      .argument("<person>", "an attendee's address as email:<address>, or a person:<id>")
      .argument("<other>", "the same person in another tool, as <provider>:<person>, or me")
      .option("--reason <text>", "why they are one person; an agent's link is a proposal and needs it")
      .addOption(asOwnerOption()),
    "people link email:ana@example.com telegram:12345",
  ).action(async (person: string, other: string, opts: { reason?: string; asOwner?: boolean }, command: Command) => {
    await within(command, async (run) => {
      const linked = await linkPeople(messagesOf(run, "people link"), run.account, person, other, {
        by: actorOf(command, opts.asOwner),
        reason: opts.reason,
      })
      return itemBody({
        person: `person:${linked.uid}`,
        name: linked.name,
        identities: linked.identities.map(({ provider, id }) => `${provider}:${id}`),
        ...(linked.proposal === undefined ? {} : { proposal: linked.proposal }),
      })
    })
  })
