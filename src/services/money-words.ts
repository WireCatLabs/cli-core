import { MONEY_WORDS } from "../domain/money-words.js"
import { listsHit } from "./task-categories.js"

export { MONEY_DONE, MONEY_REQUEST, MONEY_WORDS, PROMISE } from "../domain/money-words.js"

/** The money classes the text's words belong to; none for a text with no money verb. */
export const moneyClassesOf = (text: string): string[] => listsHit(text, MONEY_WORDS)
