/**
 * A setup text for a terminal: Desktop draws its restricted Markdown, a terminal shows `**`, `*` and `[…](…)` as
 * typed. Bold, italics and code lose their marks, and a link keeps its address beside its words, since the address
 * is what a person copies.
 */
export const plainSetupText = (text: string): string =>
  text
    .replace(/\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_all, label: string, href: string) =>
      !label || label === href || href.endsWith(label) ? href : `${label} (${href})`,
    )
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
