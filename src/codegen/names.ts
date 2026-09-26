const pascal = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("")

export const identifier = (id: string): string => {
  const name = pascal(id)
  return /^[A-Za-z]/.test(name) ? name : `Schema${name}`
}

/** `getMyInfo` → `get-my-info`. */
export const kebab = (id: string): string =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
