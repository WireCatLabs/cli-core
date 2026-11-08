/** What a row is indexed as: its title, then its text. Chunk offsets point into this. */
export const noteIndexText = (title: string | null, text: string): string => (title ? `${title}\n\n${text}` : text)
