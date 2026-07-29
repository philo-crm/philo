import { useEffect, useState } from 'react'

export function App() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/version', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: { version?: string }) => setVersion(body.version ?? null))
      .catch(() => setVersion(null))
    return () => controller.abort()
  }, [])

  return (
    <main>
      <h1>Philo</h1>
      <p>{version ? `v${version}` : 'Connecting…'}</p>
    </main>
  )
}
