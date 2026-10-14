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
