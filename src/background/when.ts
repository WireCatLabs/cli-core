/** The days `--on` takes, Monday first. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** Minutes between runs, a daily local time, a weekday's local time, or one local moment. */
export type When = { every: number } | { daily: string } | { weekly: string; on: Weekday } | { once: string }

const SYSTEMD_DAYS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
}
export const WINDOWS_DAYS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
}

/** The local time of a calendar schedule, `HH:MM`. */
export const clockOf = (when: { daily: string } | { weekly: string; on: Weekday }) =>
  "daily" in when ? when.daily : when.weekly

export const describeWhen = (when: When): string =>
  "every" in when
    ? `every ${when.every % 1440 === 0 ? `${when.every / 1440}d` : when.every % 60 === 0 ? `${when.every / 60}h` : `${when.every}m`}`
    : "daily" in when
      ? `daily at ${when.daily}`
      : "weekly" in when
        ? `weekly on ${SYSTEMD_DAYS[when.on]} at ${when.weekly}`
        : `once at ${when.once}`

export const onCalendar = (when: Exclude<When, { every: number }>) =>
  "once" in when
    ? localStamp(when.once)
    : "weekly" in when
      ? `${SYSTEMD_DAYS[when.on]} *-*-* ${when.weekly}:00`
      : `*-*-* ${when.daily}:00`

/** A local wall-clock time, as both systemd's `OnCalendar=` and PowerShell's parser take it. */
export const localStamp = (iso: string) => {
  const at = new Date(iso)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}
