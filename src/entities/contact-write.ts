import * as v from "valibot"
import { count, id, text } from "./fields.js"

const addressBookPerson = v.strictObject({ id, name: v.nullable(text), username: v.nullable(text) })

export const contactUpdate = v.strictObject({ operation_id: id, person: addressBookPerson })
export const contactStateChange = v.strictObject({ operation_id: id, person_id: id })
export const contactImport = v.strictObject({ operation_id: id, sent: count, recognised: v.array(addressBookPerson) })
