export const calendarKey = (zone: string, by: "day" | "hour") => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(by === "hour" ? { hour: "2-digit", hourCycle: "h23" } : {}),
  } as Intl.DateTimeFormatOptions)
  return (time: number) => {
    const part = Object.fromEntries(format.formatToParts(time).map(({ type, value }) => [type, value]))
    return `${part.year}-${part.month}-${part.day}${by === "hour" ? `T${part.hour}` : ""}`
  }
}

/** The Monday that starts the week of a `YYYY-MM-DD` day. */
export const weekKey = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}
