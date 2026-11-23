/**
 * A setup text for a terminal: Desktop draws its restricted Markdown, a terminal shows `**`, backticks and `[…](…)`
 * as typed. Bold and code lose their marks, and a link keeps its address beside its words, since the address is what
 * a person copies. Single `*` and `_` stay: in plain text they are as often a product or a name as italics.
 */
export const plainSetupText = (text: string): string =>
  text
    .replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_all, label: string, href: string) =>
      !label || [href, href.replace(/^https:\/\//, "")].includes(label) ? href : `${label} (${href})`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
