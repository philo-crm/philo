import { createTransport } from 'nodemailer'
import type { EmailSettings } from './settings.ts'

/**
 * How long a send may spend on a dead SMTP host. Sending is fire-and-forget off
 * the intake hook, so nothing upstream is waiting — but nothing upstream would
 * abandon a hung socket either, and an unreachable host would otherwise hold one
 * open for the OS default of minutes.
 */
export const SMTP_TIMEOUT_MS = 10_000

export interface OutgoingEmail {
  /**
   * One entry per recipient, never a pre-joined header. Nodemailer builds the
   * header from the list, so no value here can widen it into more addresses
   * than there are entries.
   */
  to: string[]
  subject: string
  html: string
  /** Where a reply should land, when it is not the From address. */
  replyTo?: string | undefined
}

export type SendEmail = (email: OutgoingEmail) => Promise<void>

/** Substituted in tests; production always passes `smtpSender`. */
export type EmailSenderFactory = (config: EmailSettings) => SendEmail

/**
 * A sender bound to the stored SMTP settings. The connection is opened per send
 * and closed after: this is a handful of messages a day on a single-tenant
 * instance, and a pooled connection would only add a socket to keep alive
 * across the settings edit that invalidates it.
 */
export const smtpSender: EmailSenderFactory = (config) => async (email) => {
  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    // An empty username is a relay that takes no credentials — passing `auth`
    // with blank values makes such a server refuse the session outright.
    auth: config.smtpUsername === ''
      ? undefined
      : { user: config.smtpUsername, pass: config.smtpPassword },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  })
  try {
    await transport.sendMail({
      // Structured rather than a formatted string, so a display name holding a
      // comma or a quote is encoded by nodemailer instead of by us.
      from: config.fromName === ''
        ? config.fromAddress
        : { name: config.fromName, address: config.fromAddress },
      to: email.to,
      subject: email.subject,
      html: email.html,
      ...(email.replyTo === undefined || email.replyTo === '' ? {} : { replyTo: email.replyTo }),
    })
  } finally {
    transport.close()
  }
}
