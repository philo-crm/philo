import { Transport, type TransportOptions } from './http.ts'
import type {
  ApiKeyRecord,
  AuthConfig,
  EmailSettings,
  EmailSettingsPatch,
  EmailTemplate,
  EmailTemplateDraft,
  EmailTemplatePatch,
  EmailTemplatePreview,
  LeadContactPatch,
  LeadDetail,
  LeadPatch,
  LiveNotification,
  LeadPage,
  LeadQuery,
  NewLead,
  Principal,
  StageRecord,
  User,
  VersionInfo,
} from './types.ts'

export type PhiloClientOptions = TransportOptions

const API = '/api/v1'

function dateParam(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

function leadQueryString(query: LeadQuery): string {
  const params = new URLSearchParams()
  if (query.isSpam !== undefined) params.set('spam', String(query.isSpam))
  if (query.stageId !== undefined) params.set('stage', String(query.stageId))
  if (query.formId !== undefined) params.set('form', String(query.formId))
  // An empty search is no search; leaving the key off says so in one place.
  const search = query.search?.trim() ?? ''
  if (search !== '') params.set('search', search)
  if (query.createdAfter !== undefined) params.set('createdAfter', dateParam(query.createdAfter))
  if (query.createdBefore !== undefined) params.set('createdBefore', dateParam(query.createdBefore))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  const encoded = params.toString()
  return encoded === '' ? '' : `?${encoded}`
}

/**
 * The one way a client reaches Philo's API. Every method is a single request;
 * failures throw `ApiError` with the server's code.
 *
 * Every credential — the PWA's token, an API key, a connector's grant — acts
 * with its user's authority, so every method is open to every client. See
 * ADR-0007.
 */
export class PhiloClient {
  readonly #http: Transport

  constructor(options: PhiloClientOptions = {}) {
    this.#http = new Transport(options)
  }

  get baseUrl(): string {
    return this.#http.baseUrl
  }

  version(signal?: AbortSignal): Promise<VersionInfo> {
    return this.#http.request('GET', '/version', undefined, signal)
  }

  readonly auth = {
    /** Public: where to sign in. Called before there is any token. */
    config: (signal?: AbortSignal): Promise<AuthConfig> =>
      this.#http.request('GET', `${API}/auth/config`, undefined, signal),

    /** What the current token is — any credential may ask. */
    principal: (signal?: AbortSignal): Promise<Principal> =>
      this.#http.request('GET', `${API}/auth/principal`, undefined, signal),

    /** The operator the current token belongs to. */
    session: async (signal?: AbortSignal): Promise<User> => {
      const body = await this.#http.request<{ user: User }>('GET', `${API}/auth/session`, undefined, signal)
      return body.user
    },
  }

  readonly leads = {
    list: (query: LeadQuery = {}, signal?: AbortSignal): Promise<LeadPage> =>
      this.#http.request('GET', `${API}/leads${leadQueryString(query)}`, undefined, signal),

    get: (id: number, signal?: AbortSignal): Promise<LeadDetail> => this.#lead('GET', `/${id}`, undefined, signal),

    /** Files a lead by hand. Sends no email — there was no submission to acknowledge. */
    create: (lead: NewLead): Promise<LeadDetail> => this.#lead('POST', '', lead),

    updateContact: (id: number, patch: LeadContactPatch): Promise<LeadDetail> =>
      this.#lead('PATCH', `/${id}`, patch),

    /** Contact fields and `details` in one patch. Only the keys of `details` named change. */
    update: (id: number, patch: LeadPatch): Promise<LeadDetail> => this.#lead('PATCH', `/${id}`, patch),

    moveStage: (id: number, stageId: number): Promise<LeadDetail> =>
      this.#lead('POST', `/${id}/stage`, { stageId }),

    addNote: (id: number, note: string): Promise<LeadDetail> => this.#lead('POST', `/${id}/notes`, { note }),

    /** The spam view's "not spam": clears the flag and fires the held-back pipeline. */
    markNotSpam: (id: number): Promise<LeadDetail> => this.#lead('POST', `/${id}/not-spam`),

    attachments: {
      /** Answers with the whole lead, the new file in its `attachments`. */
      upload: async (
        id: number,
        file: { data: Blob | Uint8Array<ArrayBuffer>; filename: string; contentType?: string | undefined },
      ): Promise<LeadDetail> => {
        const contentType = file.contentType ?? (file.data instanceof Blob ? file.data.type : '')
        const res = await this.#http.send(
          'POST',
          `${API}/leads/${id}/attachments?filename=${encodeURIComponent(file.filename)}`,
          { data: file.data, contentType: contentType === '' ? 'application/octet-stream' : contentType },
        )
        return ((await res.json()) as { lead: LeadDetail }).lead
      },

      download: async (id: number, attachmentId: number, signal?: AbortSignal): Promise<Blob> => {
        const res = await this.#http.send('GET', `${API}/leads/${id}/attachments/${attachmentId}`, undefined, signal)
        return res.blob()
      },

      remove: async (id: number, attachmentId: number): Promise<LeadDetail> => {
        const res = await this.#http.send('DELETE', `${API}/leads/${id}/attachments/${attachmentId}`)
        return ((await res.json()) as { lead: LeadDetail }).lead
      },
    },
  }

  readonly stages = {
    list: async (signal?: AbortSignal): Promise<StageRecord[]> => {
      const body = await this.#http.request<{ stages: StageRecord[] }>('GET', `${API}/stages`, undefined, signal)
      return body.stages
    },

    /** Appended to the end of the funnel — the server decides the position. */
    create: async (name: string, isTerminal: boolean): Promise<StageRecord> => {
      const body = await this.#http.request<{ stage: StageRecord }>('POST', `${API}/stages`, { name, isTerminal })
      return body.stage
    },

    update: async (
      id: number,
      patch: { name?: string | undefined; isTerminal?: boolean | undefined },
    ): Promise<StageRecord> => {
      const body = await this.#http.request<{ stage: StageRecord }>('PATCH', `${API}/stages/${id}`, patch)
      return body.stage
    },

    /** The complete funnel in its new order; the server refuses a partial one. */
    reorder: async (stageIds: number[]): Promise<StageRecord[]> => {
      const body = await this.#http.request<{ stages: StageRecord[] }>('POST', `${API}/stages/reorder`, { stageIds })
      return body.stages
    },

    /** Answers with the remaining funnel. */
    delete: async (id: number): Promise<StageRecord[]> => {
      const body = await this.#http.request<{ stages: StageRecord[] }>('DELETE', `${API}/stages/${id}`)
      return body.stages
    },
  }

  readonly emailSettings = {
    get: async (signal?: AbortSignal): Promise<EmailSettings> => {
      const body = await this.#http.request<{ settings: EmailSettings }>(
        'GET',
        `${API}/settings/email`,
        undefined,
        signal,
      )
      return body.settings
    },

    update: async (patch: EmailSettingsPatch): Promise<EmailSettings> => {
      const body = await this.#http.request<{ settings: EmailSettings }>('PATCH', `${API}/settings/email`, patch)
      return body.settings
    },

    /** Sends with the settings as stored, so save first. */
    sendTest: async (to: string): Promise<void> => {
      await this.#http.request('POST', `${API}/settings/email/test`, { to })
    },
  }

  readonly emailTemplates = {
    list: async (signal?: AbortSignal): Promise<EmailTemplate[]> => {
      const body = await this.#http.request<{ templates: EmailTemplate[] }>(
        'GET',
        `${API}/settings/email/templates`,
        undefined,
        signal,
      )
      return body.templates
    },

    get: async (trigger: string, signal?: AbortSignal): Promise<EmailTemplate> => {
      const body = await this.#http.request<{ template: EmailTemplate }>(
        'GET',
        `${API}/settings/email/templates/${encodeURIComponent(trigger)}`,
        undefined,
        signal,
      )
      return body.template
    },

    /** Refused outright if the source does not render, so nothing saves silently. */
    update: async (trigger: string, patch: EmailTemplatePatch): Promise<EmailTemplate> => {
      const body = await this.#http.request<{ template: EmailTemplate }>(
        'PATCH',
        `${API}/settings/email/templates/${encodeURIComponent(trigger)}`,
        patch,
      )
      return body.template
    },

    /** Renders and saves nothing. */
    preview: async (trigger: string, draft: EmailTemplateDraft = {}): Promise<EmailTemplatePreview> => {
      const body = await this.#http.request<{ preview: EmailTemplatePreview }>(
        'POST',
        `${API}/settings/email/templates/${encodeURIComponent(trigger)}/preview`,
        draft,
      )
      return body.preview
    },

    /** Goes to the signed-in operator's own address; answers with it. */
    sendTest: async (trigger: string, draft: EmailTemplateDraft = {}): Promise<string> => {
      const body = await this.#http.request<{ ok: true; to: string }>(
        'POST',
        `${API}/settings/email/templates/${encodeURIComponent(trigger)}/test`,
        draft,
      )
      return body.to
    },
  }

  readonly apiKeys = {
    list: async (signal?: AbortSignal): Promise<ApiKeyRecord[]> => {
      const body = await this.#http.request<{ keys: ApiKeyRecord[] }>('GET', `${API}/api-keys`, undefined, signal)
      return body.keys
    },

    /** The one call that ever sees a secret. Nothing stores it. */
    create: (name: string): Promise<{ key: ApiKeyRecord; secret: string }> =>
      this.#http.request('POST', `${API}/api-keys`, { name }),

    revoke: async (id: number): Promise<void> => {
      await this.#http.request('DELETE', `${API}/api-keys/${id}`)
    },
  }

  readonly push = {
    /** The VAPID public key a browser subscribes with (`applicationServerKey`). */
    publicKey: async (signal?: AbortSignal): Promise<string> => {
      const body = await this.#http.request<{ publicKey: string }>('GET', `${API}/push/key`, undefined, signal)
      return body.publicKey
    },

    /** Takes the serialized `PushSubscription` as the browser hands it over. */
    subscribe: async (subscription: unknown): Promise<void> => {
      await this.#http.request('POST', `${API}/push/subscriptions`, subscription)
    },

    unsubscribe: async (endpoint: string): Promise<void> => {
      await this.#http.request('DELETE', `${API}/push/subscriptions`, { endpoint })
    },

    /**
     * New leads while the stream is open, for a browser that cannot subscribe to
     * push. Settles when the server ends the stream — it does, every few minutes,
     * so the caller reconnects with a fresh token — and rejects on abort or a
     * dropped connection.
     */
    live: async (onNotification: (notification: LiveNotification) => void, signal?: AbortSignal): Promise<void> => {
      const body = await this.#http.stream(`${API}/push/live`, signal)
      for await (const event of serverSentEvents(body)) {
        if (event.name === 'lead') onNotification(JSON.parse(event.data) as LiveNotification)
      }
    },
  }

  /** Every lead mutation answers with the whole lead, so a caller never has to refetch. */
  async #lead(method: 'GET' | 'POST' | 'PATCH', suffix: string, body?: unknown, signal?: AbortSignal) {
    const answer = await this.#http.request<{ lead: LeadDetail }>(method, `${API}/leads${suffix}`, body, signal)
    return answer.lead
  }
}

interface ServerSentEvent {
  name: string
  data: string
}

/** The subset of the SSE format the server writes: `event`, `data`, and comments. */
async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        const event = parseEvent(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event !== undefined) yield event
        end = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(block: string): ServerSentEvent | undefined {
  let name = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }
  return data.length === 0 ? undefined : { name, data: data.join('\n') }
}

export function createPhiloClient(options: PhiloClientOptions = {}): PhiloClient {
  return new PhiloClient(options)
}
