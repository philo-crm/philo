import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { leadAttachmentBlobs, leadAttachments, leadEvents, leads } from '../db/schema.ts'
import { err, ok, type Result } from '../result.ts'
import { getLead, type LeadDetail } from './service.ts'

/** Per file — ADR-0008. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255

const FALLBACK_CONTENT_TYPE = 'application/octet-stream'
const TOKEN = "[a-z0-9!#$&^_.+-]+"
const CONTENT_TYPE = new RegExp(`^${TOKEN}/${TOKEN}$`)

export type AttachmentError = 'not_found' | 'attachment_not_found' | 'invalid_attachment' | 'attachment_too_large'

export interface NewAttachment {
  filename: unknown
  contentType: unknown
  data: Uint8Array
}

export interface AttachmentFile {
  filename: string
  contentType: string
  data: Buffer
}

/**
 * The name to store, or undefined. Only the last path segment is kept — a
 * browser sends a bare name, but a script might send a path — and control
 * characters are refused, since the name ends up in a response header.
 */
function cleanFilename(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = (raw.split(/[/\\]/).pop() ?? '').trim()
  if (name.length === 0 || name.length > MAX_ATTACHMENT_FILENAME_LENGTH) return undefined
  // oxlint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(name) ? undefined : name
}

/**
 * The declared type without parameters, or the generic one. Downloads are never
 * rendered inline, so a wrong type costs the reader a file association, not
 * safety — refusing the upload over it would cost them the file.
 */
function cleanContentType(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_CONTENT_TYPE
  const type = (raw.split(';')[0] ?? '').trim().toLowerCase()
  return type.length <= 127 && CONTENT_TYPE.test(type) ? type : FALLBACK_CONTENT_TYPE
}

function answer(db: Db, leadId: number): Result<LeadDetail, AttachmentError> {
  const detail = getLead(db, leadId)
  return detail === undefined ? err('not_found') : ok(detail)
}

export function addAttachment(
  db: Db,
  leadId: number,
  file: NewAttachment,
  actor: string,
): Result<LeadDetail, AttachmentError> {
  const filename = cleanFilename(file.filename)
  if (filename === undefined || file.data.byteLength === 0) return err('invalid_attachment')
  if (file.data.byteLength > MAX_ATTACHMENT_BYTES) return err('attachment_too_large')
  const contentType = cleanContentType(file.contentType)
  const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength)
  const sha256 = createHash('sha256').update(data).digest('hex')

  const found = db.transaction((tx) => {
    const [lead] = tx.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1).all()
    if (lead === undefined) return false
    const [row] = tx
      .insert(leadAttachments)
      .values({ leadId, filename, contentType, size: data.byteLength, sha256, actor })
      .returning({ id: leadAttachments.id })
      .all()
    if (row === undefined) throw new Error('attachment insert returned no row')
    tx.insert(leadAttachmentBlobs).values({ attachmentId: row.id, data }).run()
    tx.insert(leadEvents)
      .values({
        leadId,
        type: 'attachment_added',
        payload: JSON.stringify({ attachmentId: row.id, filename, size: data.byteLength }),
        actor,
      })
      .run()
    return true
  })

  return found ? answer(db, leadId) : err('not_found')
}

export function getAttachmentFile(
  db: Db,
  leadId: number,
  attachmentId: number,
): Result<AttachmentFile, AttachmentError> {
  const [row] = db
    .select({
      filename: leadAttachments.filename,
      contentType: leadAttachments.contentType,
      data: leadAttachmentBlobs.data,
    })
    .from(leadAttachments)
    .innerJoin(leadAttachmentBlobs, eq(leadAttachmentBlobs.attachmentId, leadAttachments.id))
    .where(and(eq(leadAttachments.id, attachmentId), eq(leadAttachments.leadId, leadId)))
    .limit(1)
    .all()
  return row === undefined ? err('attachment_not_found') : ok(row)
}

/** Deletes the bytes with the row — the blob cascades from it. */
export function removeAttachment(
  db: Db,
  leadId: number,
  attachmentId: number,
  actor: string,
): Result<LeadDetail, AttachmentError> {
  const outcome = db.transaction((tx) => {
    const [row] = tx
      .delete(leadAttachments)
      .where(and(eq(leadAttachments.id, attachmentId), eq(leadAttachments.leadId, leadId)))
      .returning({ filename: leadAttachments.filename, size: leadAttachments.size })
      .all()
    if (row === undefined) return 'attachment_not_found' as const
    tx.insert(leadEvents)
      .values({
        leadId,
        type: 'attachment_removed',
        payload: JSON.stringify({ attachmentId, filename: row.filename, size: row.size }),
        actor,
      })
      .run()
    return 'removed' as const
  })

  return outcome === 'removed' ? answer(db, leadId) : err(outcome)
}
