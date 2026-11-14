import { type Command, Option } from "commander"

/** `--conference`, only where the writer names services that make a meeting link (`CalendarWriter.conferences`). */
export const withConference = (command: Command, services: readonly string[] = []): Command =>
  services.length
    ? command.addOption(
        new Option("--conference <service>", "make a new meeting link with it; never replaces a link").choices([
          ...services,
        ]),
      )
    : command
