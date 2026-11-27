import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/reset-link.ts'
import { ADMIN_EMAIL, TEST_PUBLIC_BASE_URL, cleanupTestApps, createTestApp, setupAdmin } from './support/app.ts'

afterEach(() => {
  cleanupTestApps()
})

function run(args: string[], env: NodeJS.ProcessEnv) {
  const out: string[] = []
  const err: string[] = []
  const code = runCli(args, env, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out, err }
}

describe('philo reset-link', () => {
  it('prints a working reset link for an address', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const env = { PHILO_DATA_DIR: testApp.dataDir, PHILO_PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL }

    const { code, out } = run(['reset-link', ADMIN_EMAIL.toUpperCase()], env)
    expect(code).toBe(0)
    const url = new URL(out[0]!)
    expect(url.origin).toBe(TEST_PUBLIC_BASE_URL)

    const res = await testApp.app.request(url.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: TEST_PUBLIC_BASE_URL },
      body: new URLSearchParams({ password: 'a-recovered-password' }).toString(),
    })
    expect(res.status).toBe(302)
  })

  it('says so for an unknown address and bad usage', async () => {
    const testApp = createTestApp()
    await setupAdmin(testApp)
    const env = { PHILO_DATA_DIR: testApp.dataDir, PHILO_PUBLIC_BASE_URL: TEST_PUBLIC_BASE_URL }
    expect(run(['reset-link', 'nobody@example.com'], env).code).toBe(1)
    expect(run(['reset-link'], env).code).toBe(2)
    expect(run(['something-else', ADMIN_EMAIL], env).code).toBe(2)
  })
})
