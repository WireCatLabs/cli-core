/*
 * The order of the checks and the AUTOMATED_SENDER and MARKETING_SENDER patterns are ported from Zero's header
 * classifier, apps/server/src/lib/imap/categorize.ts at commit 4b642dfd9890a1fdcb1b98a177fe74ca3142c445:
 *
 * MIT License
 *
 * Copyright (c) 2025 Zero Email
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { isNoReplyAddress } from "../domain/addresses.js"
import type { Sector } from "../domain/organization-sectors.js"
import { DISCUSSION_SENDERS, type Reach, reachOfOne } from "../store/sqlite/sender-signals.js"

/**
 * What one email is, apart from who sent it: a shop's receipt is an `order` and its sale a `promotion`. The first
 * that matches wins, in this order. @experimental
 */
export const MAIL_TYPES = [
  "auto_reply",
  "security",
  "calendar",
  "travel",
  "event_ticket",
  "order",
  "shipping",
  "bill",
  "social_notification",
  "discussion_list",
  "newsletter",
  "promotion",
  "system_alert",
  "account_notice",
  "personal",
  "other",
] as const
/** @experimental */
export type MailType = (typeof MAIL_TYPES)[number]

/** What the store keeps of one email that its type is worked out from. @experimental */
export interface MailTypeInput {
  from: string | null
  subject: string | null
  /** As `mailHeadersOf` keeps them: what marks a program or a list counts only under the From domain's DKIM. */
  headers: Record<string, unknown>
  /** To and Cc together; `null` when the store holds no recipients (mail recorded as an envelope). */
  recipients: number | null
  /** The media types of its parts the store keeps as attachments, lower case. */
  parts: readonly string[]
  /** schema.org types its HTML declares (`Order`, `FlightReservation`). */
  schemaTypes: readonly string[]
  /** Distinct addresses that send to its List-Id. */
  listSenders: number
  /** The owner sent mail to this address, or this is the owner's own mail. */
  ownerWrote: boolean
  /** The sender is a sender bot. */
  bot: boolean
  /** The sector of the organization the sender's address belongs to. */
  sector: Sector | null
}

/** @experimental */
export interface MailTypeOf {
  type: MailType
  reach: Reach
  /** What decided the type; `null` for `other`. */
  signal: string | null
}

/** Automated senders: notifications, receipts, alerts (Zero). */
const AUTOMATED_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|system|accounts?|security|billing|receipts?|orders?|shipping|support|service|updates?)([+._-].*)?@/i

/** Marketing senders (Zero). */
const MARKETING_SENDER =
  /^(news(letters?)?|marketing|promo(tions?)?|offers?|deals?|sales|hello|hi|team|info|digest)([+._-].*)?@/i

const local = (words: string) => new RegExp(`^(${words})([+._-].*)?@`, "i")

const MAILER_DAEMON = local("mailer-daemon|postmaster")
const SECURITY_SENDER = local("security|account-?security|verify|verification|auth|2fa|otp|login|signin|password")
const ORDER_SENDER = local("orders?|receipts?|order-?confirm(ation)?|purchases?")
const SHIPPING_SENDER = local("shipping|shipments?|tracking|deliver(y|ies)|dispatch")
const BILL_SENDER = local("billing|invoices?|payments?|statements?")
const ALERT_SENDER = local("alerts?|alertmanager|monitoring|monitor|cron|root|ci|builds?|jenkins|nagios|zabbix|sentry")
const NEWS_SENDER = local("news(letters?)?|digest|editors?|weekly")

const AUTO_REPLY_SUBJECT =
  /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|abwesenheit|réponse automatique|respuesta automática|автоответ|автоматический ответ|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice|не доставлено)/iu
const SECURITY_SUBJECT =
  /\b(verification code|security code|one[- ]time (pass)?code|sign[- ]?in (attempt|alert|code)|new (sign[- ]?in|login|device)|log[- ]?in (attempt|alert|code)|password (reset|change)|reset your password|two[- ]factor|2-step|confirm your (email|account)|verify your (email|account|identity))\b|код (подтверждения|для входа|безопасности)|вход в (аккаунт|учётную|учетную)|сброс пароля|código de (verificación|seguridad|acceso)|restablecer (tu |la )?contraseña|inicio de sesión/iu
const TRAVEL_SUBJECT =
  /\b(boarding pass|e-?ticket|itinerary|flight (confirmation|booking|reservation)|booking confirm(ation|ed)|check[- ]in (now|is open|online))\b|посадочный талон|маршрутная квитанция|tarjeta de embarque|confirmación de (reserva|vuelo)/iu
const EVENT_SUBJECT = /\b(your tickets?|ticket confirmation|tickets? for)\b|билеты? на|tus entradas|entradas para/iu
const ORDER_SUBJECT =
  /\b(order (confirmation|confirmed|received|#|no\.?|number)|your order|thank(s| you) for your (order|purchase)|purchase confirmation|your receipt|receipt for|payment receipt)\b|ваш заказ|заказ (№|#|оформлен|принят)|tu pedido|confirmación de (pedido|compra)/iu
const SHIPPING_SUBJECT =
  /\b(has (been )?shipped|out for delivery|has been delivered|on (its|the) way|tracking (number|info)|track your (order|package|parcel)|shipment|dispatched)\b|отправлен|доставлен|посылк|tu (pedido|paquete) (ha sido enviado|está en camino)|en camino/iu
const BILL_SUBJECT =
  /\b(invoice|statement (is )?(ready|available)|your (monthly |account )?statement|payment (due|reminder|received|confirmation|failed)|bill (is )?(ready|due)|your bill)\b|сч[её]т (на оплату|№|#)|выписка|квитанция|factura|extracto|recibo de pago/iu
const ALERT_SUBJECT =
  /^\[(firing|resolved|alert)|\b(build (failed|passed|fixed|broken)|pipeline (failed|succeeded)|cron <|is down|downtime)\b/iu
const PROMOTION_SUBJECT =
  /\d+\s?%|\b(sale|discount|deals?|offers?|coupon|promo(code)?|free shipping|black friday|cyber monday|limited time|last chance)\b|скидк|распродаж|промокод|descuento|oferta|rebajas|cupón/iu
const NEWS_SUBJECT = /\b(newsletter|digest|weekly|monthly|issue\s?#?\d+|edition)\b|рассылка|дайджест|boletín/iu

const REPORT_PARTS = new Set(["message/delivery-status", "message/disposition-notification"])
const CALENDAR_PARTS = new Set(["text/calendar", "application/ics"])
const TRAVEL_SCHEMA = /^(Flight|Train|Bus|Lodging|RentalCar|Taxi|Boat)Reservation$/

const schemaOf = (types: readonly string[], wanted: RegExp | string): string | undefined =>
  types.find((one) => (typeof wanted === "string" ? one === wanted : wanted.test(one)))

/**
 * One email's type, reach and the signal behind the type, from what the store keeps of it alone: no lookup, no model.
 * Mail from someone the owner writes to is typed by what the mail itself carries (a calendar or report part, schema.org
 * markup, list headers), never by an address word or a subject alone: `info@` is often a person. @experimental
 */
export const mailTypeOf = (input: MailTypeInput): MailTypeOf => {
  const { headers } = input
  const from = input.from ?? ""
  const subject = input.subject ?? ""
  const oneClick = headers["list-unsubscribe-post"] === true
  const feedbackId = headers["feedback-id"] === true
  const listUnsubscribe = headers["list-unsubscribe"] === true
  const listId = typeof headers["list-id"] === "string"
  const precedence = typeof headers.precedence === "string" ? headers.precedence : ""
  const bulkPrecedence = precedence === "bulk" || precedence === "junk"
  const autoSubmitted = headers["auto-submitted"] !== undefined
  // With a List-Id, its senders decide: one sender, even under `+tag` addresses, writes a newsletter.
  const discussion = listId
    ? input.listSenders >= DISCUSSION_SENDERS
    : precedence === "list" && !feedbackId && !MARKETING_SENDER.test(from)
  const mass = listUnsubscribe || bulkPrecedence || listId || oneClick
  const transactional = !mass && !feedbackId
  const noReply = from !== "" && isNoReplyAddress(from)
  const person = input.ownerWrote && !input.bot
  // A forged `security@` would lend a phishing mail the look of a real alert.
  const trusted = headers.dmarc !== "fail" && headers.dkim !== "fail"
  const weak = !person && !oneClick && !listId
  const reach = reachOfOne({
    autoSubmitted,
    nullReturnPath: headers["null-return-path"] === true,
    oneClick,
    feedbackId,
    bulk: mass || precedence === "list",
    discussionList: discussion,
    recipients: input.recipients,
  }).reach
  const typed = (type: MailType, signal: string | null): MailTypeOf => ({ type, reach, signal })
  const schema = (wanted: RegExp | string) => schemaOf(input.schemaTypes, wanted)

  const report = input.parts.find((part) => REPORT_PARTS.has(part))
  if (report !== undefined) return typed("auto_reply", report)
  if (MAILER_DAEMON.test(from)) return typed("auto_reply", "mailer-daemon")
  if (!mass && AUTO_REPLY_SUBJECT.test(subject)) return typed("auto_reply", "auto-reply-subject")
  if (weak && trusted && SECURITY_SENDER.test(from)) return typed("security", "security-address")
  if (weak && trusted && SECURITY_SUBJECT.test(subject)) return typed("security", "security-subject")
  const calendar = input.parts.find((part) => CALENDAR_PARTS.has(part))
  if (calendar !== undefined) return typed("calendar", calendar)

  const travel = schema(TRAVEL_SCHEMA)
  if (travel !== undefined) return typed("travel", `schema:${travel}`)
  if (weak && TRAVEL_SUBJECT.test(subject)) return typed("travel", "travel-subject")
  if (weak && transactional && input.sector === "airline") return typed("travel", "sector:airline")
  if (schema("EventReservation") !== undefined) return typed("event_ticket", "schema:EventReservation")
  if (weak && EVENT_SUBJECT.test(subject)) return typed("event_ticket", "ticket-subject")
  if (schema("Order") !== undefined) return typed("order", "schema:Order")
  if (weak && ORDER_SENDER.test(from)) return typed("order", "order-address")
  // "Your order has shipped" names the order but reports the parcel.
  if (weak && ORDER_SUBJECT.test(subject) && !SHIPPING_SUBJECT.test(subject)) return typed("order", "order-subject")
  if (schema("ParcelDelivery") !== undefined) return typed("shipping", "schema:ParcelDelivery")
  if (weak && SHIPPING_SENDER.test(from)) return typed("shipping", "shipping-address")
  if (weak && SHIPPING_SUBJECT.test(subject)) return typed("shipping", "shipping-subject")
  if (weak && transactional && input.sector === "delivery") return typed("shipping", "sector:delivery")
  if (schema("Invoice") !== undefined) return typed("bill", "schema:Invoice")
  if (weak && BILL_SENDER.test(from)) return typed("bill", "bill-address")
  if (weak && BILL_SUBJECT.test(subject)) return typed("bill", "bill-subject")

  if (!person && input.sector === "social") return typed("social_notification", "sector:social")
  if (discussion) return typed("discussion_list", listId ? "discussion-list" : "precedence-list")
  // Transactional mail sometimes carries List-Unsubscribe: an automated sender with no campaign marker sends notices.
  const automated = AUTOMATED_SENDER.test(from) && !MARKETING_SENDER.test(from)
  if (listUnsubscribe && !oneClick && !feedbackId && !bulkPrecedence && automated)
    return typed("account_notice", "automated-address")
  if (mass || feedbackId) {
    if (PROMOTION_SUBJECT.test(subject)) return typed("promotion", "promotion-subject")
    if (MARKETING_SENDER.test(from) && !NEWS_SENDER.test(from)) return typed("promotion", "marketing-address")
    if (listId) return typed("newsletter", "list-id")
    if (NEWS_SENDER.test(from)) return typed("newsletter", "newsletter-address")
    if (NEWS_SUBJECT.test(subject)) return typed("newsletter", "newsletter-subject")
    if (input.sector === "news") return typed("newsletter", "sector:news")
    if (!input.bot && !noReply) return typed("newsletter", "person-sender")
    return typed("promotion", oneClick ? "one-click-unsubscribe" : feedbackId ? "feedback-id" : "bulk-mail")
  }

  if (!person && (ALERT_SENDER.test(from) || ALERT_SUBJECT.test(subject)))
    return typed("system_alert", ALERT_SENDER.test(from) ? "alert-address" : "alert-subject")
  if (!person && autoSubmitted) return typed("account_notice", "auto-submitted")
  if (!person && noReply) return typed("account_notice", "no-reply")
  if (!person && AUTOMATED_SENDER.test(from)) return typed("account_notice", "automated-address")
  if (person) return typed("personal", "owner-wrote")
  if (!input.bot && headers["null-return-path"] !== true) return typed("personal", "person")
  return typed("other", null)
}

const JSON_LD_OPEN = /<script[^>]*type\s*=\s*["']?application\/ld\+json[^>]*>/gi
const ITEM_TYPE = /\bitemtype\s*=\s*["']?https?:\/\/schema\.org\/([A-Za-z]+)/gi
const LD_TYPE = /"@type"\s*:\s*"(?:https?:\/\/schema\.org\/)?([A-Za-z]+)"/g

/** The schema.org types an email's HTML declares, in JSON-LD or microdata, as Gmail's markup reads them. @experimental */
export const schemaTypesOf = (html: string | null): string[] => {
  if (html === null || html === "") return []
  const found = new Set<string>()
  for (const open of html.matchAll(JSON_LD_OPEN)) {
    const start = open.index + open[0].length
    const end = html.indexOf("</script>", start)
    // An unclosed block ends the scan: every later opener would search to the end again.
    if (end === -1) break
    for (const [, type] of html.slice(start, end).matchAll(LD_TYPE)) found.add(type as string)
  }
  for (const [, type] of html.matchAll(ITEM_TYPE)) found.add(type as string)
  return [...found]
}
