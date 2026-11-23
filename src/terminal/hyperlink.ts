/**
 * Whether the terminal draws an OSC 8 link. One that does not drops the escape and shows only the words, so the address
 * would be lost: only terminals known to draw it get one, and `FORCE_HYPERLINK=1` or `=0` decides for any other.
 * tmux and screen pass the escape on only when set up to, so they get the address.
 */
export const drawsHyperlinks = (env: NodeJS.ProcessEnv): boolean => {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== "0"
  if (env.TMUX || env.STY || env.CI || env.TERM === "dumb") return false
  if (Number(env.VTE_VERSION) >= 5000) return true
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION || env.WEZTERM_EXECUTABLE) return true
  return ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? "")
}

/** The words as a link to the address; a BEL or ESC in either would end the sequence early, so they are dropped. */
export const hyperlink = (label: string, href: string): string => {
  const clean = (text: string) => [...text].filter((char) => char >= " " && char !== "\u007f").join("")
  return `\u001b]8;;${clean(href)}\u0007${clean(label)}\u001b]8;;\u0007`
}
