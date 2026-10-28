import type { MailFacts } from "./rules.js"
import { registrableOf } from "./score.js"

/**
 * Kinds of mail every mailbox gets, matched by who sends them and how, not by a list of the owner's senders. Mail
 * from someone the owner wrote to never matches a preset, so a real conversation is never caught by one.
 */
export const PRESETS = {
  social: {
    about: "notifications from social networks",
    domains: [
      "facebookmail.com",
      "facebook.com",
      "linkedin.com",
      "twitter.com",
      "x.com",
      "instagram.com",
      "vk.com",
      "ok.ru",
      "quora.com",
      "redditmail.com",
      "pinterest.com",
      "tiktok.com",
      "meetup.com",
      "tumblr.com",
      "youtube.com",
    ],
  },
  newsletters: {
    about: "mailing lists with an unsubscribe link: List-Id and List-Unsubscribe, or a newsletter service",
    domains: ["substack.com", "mcsv.net", "mailchimpapp.net", "sendinblue.com", "beehiiv.com", "convertkit.com"],
  },
  developer: {
    about: "code hosting, CI, package and error-tracker notifications",
    domains: [
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "atlassian.net",
      "circleci.com",
      "travis-ci.com",
      "rollbar.com",
      "sentry.io",
      "vercel.com",
      "netlify.com",
      "npmjs.com",
      "docker.com",
      "heroku.com",
      "codecov.io",
      "libraries.io",
    ],
  },
  shopping: {
    about: "shops and promotions, and what Gmail files under Promotions",
    domains: [
      "aliexpress.com",
      "aliexpress.ru",
      "ebay.com",
      "ozon.ru",
      "wildberries.ru",
      "steampowered.com",
      "booking.com",
      "zalando.com",
      "etsy.com",
      "ikea.com",
    ],
  },
  alerts: {
    about: "monitoring and uptime alerts",
    domains: [
      "uptimerobot.com",
      "pingdom.com",
      "statuscake.com",
      "pagerduty.com",
      "opsgenie.com",
      "newrelic.com",
      "datadoghq.com",
      "betteruptime.com",
      "healthchecks.io",
    ],
  },
} as const

export type PresetName = keyof typeof PRESETS

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[]

export const presetMatches = (name: PresetName, facts: MailFacts): boolean => {
  const { headers } = facts
  const sender = headers?.from
  if (sender === undefined || facts.replied) return false
  const domain = registrableOf(sender)
  if ((PRESETS[name].domains as readonly string[]).includes(domain)) return true
  if (name === "newsletters") return headers?.listId !== undefined && headers.bulk
  if (name === "shopping") return facts.labels?.includes("Promotions") ?? false
  return false
}
