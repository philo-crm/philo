import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountLinks, users } from '../src/db/schema.ts'
import { TEST_PUBLIC_BASE_URL, cleanupTestApps, createTestApp, jsonPost, setupAdmin } from './support/app.ts'

// Runs a hook while the link page hashes the new password: the window between
// the page checking the link and the transaction that claims it.
const whileHashing = vi.hoisted(() => ({ hook: undefined as (() => void) | undefined }))
vi.mock('../src/auth/password.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/password.ts')>()
  return {
    ...actual,
    hashPassword: async (password: string) => {
      const hook = whileHashing.hook
      whileHashing.hook = undefined
      hook?.()
      return actual.hashPassword(password)
    },
  }
})

afterEach(() => {
  whileHashing.hook = undefined
  cleanupTestApps()
})

describe('a link used while its account is deactivated', () => {
  it('is refused and left unused', async () => {
    const testApp = createTestApp()
    const admin = await setupAdmin(testApp)
    const res = await testApp.app.request(
      '/api/v1/users',
      jsonPost({ email: 'sam@example.com', role: 'user' }, { authorization: admin }),
    )
    expect(res.status).toBe(201)
    const { user, inviteUrl } = (await res.json()) as { user: { id: number }; inviteUrl: string }

    whileHashing.hook = () => {
      testApp.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id)).run()
    }
    const used = await testApp.app.request(new URL(inviteUrl).pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_PUBLIC_BASE_URL },
      body: new URLSearchParams({ password: 'a-brand-new-long-password' }).toString(),
    })
    expect(used.status).toBe(410)
    const [link] = testApp.db.select().from(accountLinks).where(eq(accountLinks.userId, user.id)).all()
    expect(link!.usedAt).toBeNull()
  })
})
