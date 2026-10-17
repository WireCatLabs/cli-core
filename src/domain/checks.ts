/**
 * Names a command a message sends a person to, in one pair of backticks. `check` is its path with dots
 * (`chats.list`): an adapter knows which command, and only the command layer knows the CLI and the profile.
 */
export type CheckWords<C extends string = string> = (check: C, args?: string) => string

const spelled = (check: string, args: string | undefined) =>
  `${check.replaceAll(".", " ")}${args === undefined ? "" : ` ${args}`}`

/** Without the command layer's words, a check is named by its command path alone. */
export const bareCheck = <C extends string>(check: C, args?: string): string => `\`${spelled(check, args)}\``

/** The command layer's words: the CLI and, when given, the profile first — `` `wa personal chats list` ``. */
export const checkWords =
  <C extends string>(command: string, profile?: string): CheckWords<C> =>
  (check, args) =>
    `\`${command} ${profile === undefined ? "" : `${profile} `}${spelled(check, args)}\``
