/** A job or schedule saved before `store fetch` became `messages sync` (2026-10-12) runs under the new path. */
export const currentArgv = (argv: readonly string[]): string[] => {
  const at = argv.slice(0, 2).findIndex((word, index) => word === "store" && argv[index + 1] === "fetch")
  return at === -1 ? [...argv] : [...argv.slice(0, at), "messages", "sync", ...argv.slice(at + 2)]
}
