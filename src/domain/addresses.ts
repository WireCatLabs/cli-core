/** One reading of an email address everywhere a person is matched by one: a local part, an `@` and a dotted domain. */
export const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

/** Whether a lower-cased, trimmed value is an email address. */
export const isEmailAddress = (value: string): boolean => EMAIL_ADDRESS.test(value)
