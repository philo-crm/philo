import { describe, expect, it } from 'vitest'
import * as apiKeys from '../src/auth/api-keys.ts'
import * as password from '../src/auth/password.ts'
import * as emailSettings from '../src/email/settings.ts'
import * as templates from '../src/email/templates.ts'
import * as funnels from '../src/funnels/service.ts'
import * as attachments from '../src/leads/attachments.ts'
import * as leads from '../src/leads/service.ts'
import * as stages from '../src/stages/service.ts'
import * as feed from '../src/events/feed.ts'
import * as webhooks from '../src/webhooks/service.ts'
import * as intake from '../src/intake/payload.ts'
import * as sdk from '../../sdk/src/limits.ts'

// The SDK tracks the server. These bounds are copied rather than imported so
// the SDK ships with no server code in it; this is what keeps the copies honest.
describe('limits mirror the server', () => {
  it('matches every constant it copies', () => {
    expect({
      DEFAULT_PAGE_SIZE: sdk.DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE: sdk.MAX_PAGE_SIZE,
      MAX_SEARCH_LENGTH: sdk.MAX_SEARCH_LENGTH,
      MAX_NOTE_LENGTH: sdk.MAX_NOTE_LENGTH,
      MAX_CONTACT_FIELD_LENGTH: sdk.MAX_CONTACT_FIELD_LENGTH,
      MAX_EMAIL_LENGTH: sdk.MAX_EMAIL_LENGTH,
      MAX_DETAIL_KEY_LENGTH: sdk.MAX_DETAIL_KEY_LENGTH,
      MAX_DETAILS_BYTES: sdk.MAX_DETAILS_BYTES,
      MAX_ATTACHMENT_BYTES: sdk.MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENT_FILENAME_LENGTH: sdk.MAX_ATTACHMENT_FILENAME_LENGTH,
      MAX_STAGE_NAME_LENGTH: sdk.MAX_STAGE_NAME_LENGTH,
      MAX_FUNNEL_NAME_LENGTH: sdk.MAX_FUNNEL_NAME_LENGTH,
      MAX_NOTIFY_RECIPIENTS: sdk.MAX_NOTIFY_RECIPIENTS,
      MAX_SETTINGS_NAME_LENGTH: sdk.MAX_SETTINGS_NAME_LENGTH,
      MAX_TEMPLATE_SUBJECT_LENGTH: sdk.MAX_TEMPLATE_SUBJECT_LENGTH,
      MAX_TEMPLATE_BODY_LENGTH: sdk.MAX_TEMPLATE_BODY_LENGTH,
      TEMPLATE_TRIGGERS: sdk.TEMPLATE_TRIGGERS,
      MAX_API_KEY_NAME_LENGTH: sdk.MAX_API_KEY_NAME_LENGTH,
      MIN_PASSWORD_LENGTH: sdk.MIN_PASSWORD_LENGTH,
      MAX_WEBHOOKS: sdk.MAX_WEBHOOKS,
      MAX_WEBHOOK_URL_LENGTH: sdk.MAX_WEBHOOK_URL_LENGTH,
      MAX_AUTH_HEADER_NAME_LENGTH: sdk.MAX_AUTH_HEADER_NAME_LENGTH,
      MAX_AUTH_HEADER_VALUE_LENGTH: sdk.MAX_AUTH_HEADER_VALUE_LENGTH,
      CHANGE_TYPES: sdk.CHANGE_TYPES,
      HONEYPOT_FIELD: sdk.HONEYPOT_FIELD,
    }).toEqual({
      DEFAULT_PAGE_SIZE: leads.DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE: leads.MAX_PAGE_SIZE,
      MAX_SEARCH_LENGTH: leads.MAX_SEARCH_LENGTH,
      MAX_NOTE_LENGTH: leads.MAX_NOTE_LENGTH,
      MAX_CONTACT_FIELD_LENGTH: leads.MAX_CONTACT_FIELD_LENGTH,
      MAX_EMAIL_LENGTH: leads.MAX_EMAIL_LENGTH,
      MAX_DETAIL_KEY_LENGTH: leads.MAX_DETAIL_KEY_LENGTH,
      MAX_DETAILS_BYTES: leads.MAX_DETAILS_BYTES,
      MAX_ATTACHMENT_BYTES: attachments.MAX_ATTACHMENT_BYTES,
      MAX_ATTACHMENT_FILENAME_LENGTH: attachments.MAX_ATTACHMENT_FILENAME_LENGTH,
      MAX_STAGE_NAME_LENGTH: stages.MAX_STAGE_NAME_LENGTH,
      MAX_FUNNEL_NAME_LENGTH: funnels.MAX_FUNNEL_NAME_LENGTH,
      MAX_NOTIFY_RECIPIENTS: funnels.MAX_NOTIFY_RECIPIENTS,
      MAX_SETTINGS_NAME_LENGTH: emailSettings.MAX_NAME_LENGTH,
      MAX_TEMPLATE_SUBJECT_LENGTH: templates.MAX_TEMPLATE_SUBJECT_LENGTH,
      MAX_TEMPLATE_BODY_LENGTH: templates.MAX_TEMPLATE_BODY_LENGTH,
      TEMPLATE_TRIGGERS: templates.TEMPLATE_TRIGGERS,
      MAX_API_KEY_NAME_LENGTH: apiKeys.MAX_API_KEY_NAME_LENGTH,
      MIN_PASSWORD_LENGTH: password.MIN_PASSWORD_LENGTH,
      MAX_WEBHOOKS: webhooks.MAX_WEBHOOKS,
      MAX_WEBHOOK_URL_LENGTH: webhooks.MAX_WEBHOOK_URL_LENGTH,
      MAX_AUTH_HEADER_NAME_LENGTH: webhooks.MAX_AUTH_HEADER_NAME_LENGTH,
      MAX_AUTH_HEADER_VALUE_LENGTH: webhooks.MAX_AUTH_HEADER_VALUE_LENGTH,
      CHANGE_TYPES: feed.CHANGE_TYPES,
      HONEYPOT_FIELD: intake.HONEYPOT_FIELD,
    })
  })
})
