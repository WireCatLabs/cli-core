/** The days `--on` takes, Monday first. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** One calendar time: `HH:MM` local, every day or on one weekday. */
export interface Slot {
  at: string
  on?: Weekday
}

/**
 * Minutes between runs, a daily local time, a weekday's local time, several of either, or one local moment. One
 * `--at` keeps the `daily` or `weekly` shape that schedules were saved in before `calendar` existed.
 */
export type When =
  | { every: number }
  | { daily: string }
  | { weekly: string; on: Weekday }
  | { calendar: Slot[] }
  | { once: string }

export type CalendarWhen = Extract<When, { daily: string } | { weekly: string } | { calendar: Slot[] }>

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

export const isCalendar = (when: When): when is CalendarWhen =>
  "daily" in when || "weekly" in when || "calendar" in when

/** A calendar schedule's times, whichever shape it was saved in. */
export const slotsOf = (when: CalendarWhen): Slot[] =>
  "daily" in when ? [{ at: when.daily }] : "weekly" in when ? [{ at: when.weekly, on: when.on }] : when.calendar

/** The shape a schedule is saved in: one slot as `daily` or `weekly`, so files and their wording stay as they were. */
export const calendarOf = (slots: readonly Slot[]): CalendarWhen => {
  const seen = new Map(slots.map((slot) => [`${slot.on ?? ""} ${slot.at}`, slot]))
  const unique = [...seen.values()].sort(
    (a, b) => (a.on ? WEEKDAYS.indexOf(a.on) : -1) - (b.on ? WEEKDAYS.indexOf(b.on) : -1) || a.at.localeCompare(b.at),
  )
  const [one] = unique
  if (unique.length === 1 && one) return one.on ? { weekly: one.at, on: one.on } : { daily: one.at }
  return { calendar: unique }
}

const describeSlots = (slots: Slot[]): string => {
  const times = [...new Set(slots.map((slot) => slot.at))].sort()
  const days = [...new Set(slots.flatMap((slot) => (slot.on ? [slot.on] : [])))]
  if (days.length === 0) return `daily at ${times.join(", ")}`
  if (slots.every((slot) => slot.on) && slots.length === times.length * days.length)
    return `weekly on ${days.map((day) => SYSTEMD_DAYS[day]).join(", ")} at ${times.join(", ")}`
  return `at ${slots.map((slot) => (slot.on ? `${SYSTEMD_DAYS[slot.on]} ${slot.at}` : `daily ${slot.at}`)).join(", ")}`
}

export const describeWhen = (when: When): string =>
  "every" in when
    ? `every ${when.every % 1440 === 0 ? `${when.every / 1440}d` : when.every % 60 === 0 ? `${when.every / 60}h` : `${when.every}m`}`
    : "once" in when
      ? `once at ${when.once}`
      : describeSlots(slotsOf(when))

/** systemd's `OnCalendar=` values: one per slot, as a timer may carry several. */
export const onCalendar = (when: Exclude<When, { every: number }>): string[] =>
  "once" in when
    ? [localStamp(when.once)]
    : slotsOf(when).map((slot) => (slot.on ? `${SYSTEMD_DAYS[slot.on]} *-*-* ${slot.at}:00` : `*-*-* ${slot.at}:00`))

/** The local moments of a calendar schedule's runs from `from` (inclusive) to `to` (exclusive), oldest first. */
export const runsBetween = (when: CalendarWhen, from: number, to: number): number[] => {
  const slots = slotsOf(when)
  const moments: number[] = []
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  for (; day.getTime() < to; day.setDate(day.getDate() + 1)) {
    const weekday = WEEKDAYS[(day.getDay() + 6) % 7]
    for (const slot of slots) {
      if (slot.on && slot.on !== weekday) continue
      const [hour, minute] = slot.at.split(":").map(Number) as [number, number]
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime()
      if (at >= from && at < to) moments.push(at)
    }
  }
  return moments.sort((a, b) => a - b)
}

const WEEK = 7 * 86_400_000

/** The run a calendar schedule has next after `now`, or the one before or at it; a week holds every slot once. */
export const nextRun = (when: CalendarWhen, now: number): number | undefined =>
  runsBetween(when, now + 1, now + WEEK + 1)[0]
export const previousRun = (when: CalendarWhen, now: number): number | undefined =>
  runsBetween(when, now - WEEK, now + 1).at(-1)

/** A local wall-clock time, as both systemd's `OnCalendar=` and PowerShell's parser take it. */
export const localStamp = (iso: string) => {
  const at = new Date(iso)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`
}
