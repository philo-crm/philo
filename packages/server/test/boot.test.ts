import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootServer, loadConfig, type ChangeEvent } from '../src/boot.ts'
import { openDatabase, type Db } from '../src/db/index.ts'
import { intakeForms } from '../src/db/schema.ts'

const dataDirs: string[] = []
const dbs: Db[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  for (const db of dbs.splice(0)) db.$client.close()
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('bootServer', () => {
  it('hands back the change feed, so an embedding entrypoint can listen in process', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'philo-boot-'))
    dataDirs.push(dataDir)
    const server = bootServer(loadConfig({ PHILO_DATA_DIR: dataDir }))
    const events: ChangeEvent[] = []
    const stop = server.changes.listen((event) => events.push(event))

    // The seeded form, read through a second connection: the booted one is not exposed.
    const db = openDatabase(dataDir)
    dbs.push(db)
    const [form] = db.select({ formKey: intakeForms.formKey }).from(intakeForms).limit(1).all()

    const res = await server.app.request(`/api/intake/${form!.formKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dana@example.com' }),
    })
    expect(res.status).toBe(201)
    expect(events.map((event) => event.type)).toEqual(['lead.created'])

    stop()
    expect(server.changes).not.toHaveProperty('publish')
  })
})
