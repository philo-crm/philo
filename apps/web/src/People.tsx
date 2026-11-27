import { useCallback, useState, type FormEvent } from 'react'
import {
  fetchPeople,
  invitePerson,
  issueResetLink,
  peopleErrorMessage,
  reinvitePerson,
  updatePerson,
  MAX_PERSON_NAME_LENGTH,
  type PeopleList,
  type Person,
  type PersonStatus,
  type Role,
} from './api.ts'
import { formatDateTime } from './format.ts'
import { SettingsSection } from './SettingsLayout.tsx'
import { useResource, useSessionGuard } from './useResource.ts'

export interface PeopleProps {
  /** Your own row: nobody changes their own role or deactivates themself (ADR-0012). */
  currentUserId: number
  onSessionExpired: () => void
}

const ROLE_LABELS: Record<Role, string> = { user: 'User', admin: 'Admin' }

const STATUS_LABELS: Record<PersonStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Deactivated',
  no_access: 'No access',
}

/** A link from the one response that carries it — never refetched, gone once dismissed. */
interface ShownLink {
  purpose: 'invite' | 'reset'
  email: string
  url: string
  expiresAt: string
}

function displayName(person: Person): string {
  return person.name ?? person.email
}

/**
 * People — ADR-0012. Who may sign in and as what: an admin invites, changes
 * roles, deactivates and reactivates, and issues reset links. With an external
 * IdP the IdP admits people and may own their roles, so only deactivation —
 * which Philo enforces whatever the IdP says — stays here.
 */
export function People({ currentUserId, onSessionExpired }: PeopleProps) {
  const load = useCallback((signal: AbortSignal) => fetchPeople(signal), [])
  const people = useResource(load)
  useSessionGuard(people.error, onSessionExpired)

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [link, setLink] = useState<ShownLink | undefined>(undefined)
  /** Which person the Deactivate button is waiting for a second click on. */
  const [confirming, setConfirming] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  useSessionGuard(error, onSessionExpired)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  /** As ApiKeys does: a change lands on a loaded list, or the list is asked for again. */
  function applyToList(person: Person) {
    const current = people.data
    if (current === undefined) {
      people.reload()
      return
    }
    const known = current.users.some((row) => row.id === person.id)
    const users = known ? current.users.map((row) => (row.id === person.id ? person : row)) : [...current.users, person]
    people.set({ ...current, users })
  }

  function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (email.trim() === '') return
    void run(async () => {
      const trimmedName = name.trim()
      const invited = await invitePerson({ email: email.trim(), role, name: trimmedName === '' ? null : trimmedName })
      setLink({ purpose: 'invite', email: invited.user.email, url: invited.inviteUrl, expiresAt: invited.expiresAt })
      setEmail('')
      setName('')
      setRole('user')
      applyToList(invited.user)
    })
  }

  function handleRole(person: Person, next: Role) {
    void run(async () => applyToList(await updatePerson(person.id, { role: next })))
  }

  function handleDeactivate(person: Person) {
    if (confirming !== person.id) {
      setConfirming(person.id)
      return
    }
    setConfirming(undefined)
    void run(async () => {
      applyToList(await updatePerson(person.id, { disabled: true }))
      // Deactivation voids their pending links, so one on screen would mislead.
      if (link?.email === person.email) setLink(undefined)
    })
  }

  function handleReactivate(person: Person) {
    void run(async () => applyToList(await updatePerson(person.id, { disabled: false })))
  }

  function handleReinvite(person: Person) {
    void run(async () => {
      const invited = await reinvitePerson(person.id)
      setLink({ purpose: 'invite', email: invited.user.email, url: invited.inviteUrl, expiresAt: invited.expiresAt })
    })
  }

  function handleReset(person: Person) {
    void run(async () => {
      const reset = await issueResetLink(person.id)
      setLink({ purpose: 'reset', email: person.email, url: reset.resetUrl, expiresAt: reset.expiresAt })
    })
  }

  const list = people.data

  return (
    <SettingsSection
      title="People"
      description="Everyone who can sign in. Users work every lead in every funnel; admins also configure the instance and manage people."
    >
      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {peopleErrorMessage(error)}
        </p>
      )}

      {link !== undefined && <OneTimeLink key={link.url} link={link} onDismiss={() => setLink(undefined)} />}

      {list !== undefined && <IdpNote list={list} />}

      {list?.invites === true && (
        <form className="panel people-invite" aria-label="Invite someone" onSubmit={handleInvite}>
          <div className="field-row field-row-end">
            <label className="field field-grow">
              <span className="field-label">Email</span>
              <input
                type="email"
                value={email}
                autoComplete="off"
                placeholder="colleague@example.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="field field-grow">
              <span className="field-label">Name (optional)</span>
              <input
                value={name}
                autoComplete="off"
                maxLength={MAX_PERSON_NAME_LENGTH}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                <option value="user">{ROLE_LABELS.user}</option>
                <option value="admin">{ROLE_LABELS.admin}</option>
              </select>
            </label>
            <button type="submit" disabled={busy || email.trim() === ''}>
              {busy ? 'Working…' : 'Invite'}
            </button>
          </div>
          <p className="hint">
            Philo makes a one-time link for them to set their own password. It is shown once, here, for you to pass on.
          </p>
        </form>
      )}

      {list === undefined ? (
        people.error === undefined ? (
          <p className="empty">Loading…</p>
        ) : (
          <p className="notice notice-error" role="alert">
            {peopleErrorMessage(people.error)}
          </p>
        )
      ) : (
        <div className="grid-scroll">
          <table className="grid people-grid">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.users.map((person) => {
                const self = person.id === currentUserId
                const label = displayName(person)
                return (
                  <tr key={person.id}>
                    <td>
                      {person.name ?? <span className="muted">—</span>}
                      {self && <span className="tag tag-accent people-you">You</span>}
                    </td>
                    <td>{person.email}</td>
                    <td>
                      {self || list.rolesManagedByIdp ? (
                        person.role === null ? (
                          <span className="muted">—</span>
                        ) : (
                          ROLE_LABELS[person.role]
                        )
                      ) : (
                        <select
                          aria-label={`Role for ${label}`}
                          value={person.role ?? ''}
                          disabled={busy}
                          onChange={(event) => handleRole(person, event.target.value as Role)}
                        >
                          {person.role === null && <option value="">—</option>}
                          <option value="user">{ROLE_LABELS.user}</option>
                          <option value="admin">{ROLE_LABELS.admin}</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={person.status === 'active' ? 'tag' : 'tag tag-muted'}>
                        {STATUS_LABELS[person.status]}
                      </span>
                    </td>
                    <td>
                      {!self && (
                        <div className="row-actions">
                          {list.invites && person.status === 'invited' && (
                            <button
                              type="button"
                              aria-label={`New invite link for ${label}`}
                              disabled={busy}
                              onClick={() => handleReinvite(person)}
                            >
                              New invite link
                            </button>
                          )}
                          {list.invites && (person.status === 'active' || person.status === 'no_access') && (
                            <button
                              type="button"
                              aria-label={`Reset link for ${label}`}
                              disabled={busy}
                              onClick={() => handleReset(person)}
                            >
                              Reset link
                            </button>
                          )}
                          {person.status === 'disabled' ? (
                            <button
                              type="button"
                              aria-label={`Reactivate ${label}`}
                              disabled={busy}
                              onClick={() => handleReactivate(person)}
                            >
                              Reactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label={confirming === person.id ? `Confirm deactivating ${label}` : `Deactivate ${label}`}
                              disabled={busy}
                              onClick={() => handleDeactivate(person)}
                            >
                              {confirming === person.id ? 'Confirm deactivate' : 'Deactivate'}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Deactivating signs someone out everywhere and revokes their API keys and connected apps. What they did on any
        lead stays. Reactivating lets them sign in again, but does not bring the keys back.
      </p>
    </SettingsSection>
  )
}

/** With an external IdP: who comes in, and maybe as what, is decided there. */
function IdpNote({ list }: { list: PeopleList }) {
  if (list.invites && !list.rolesManagedByIdp) return null
  const parts: string[] = []
  if (!list.invites) {
    parts.push('People sign in through your identity provider, and get an account here the first time they do.')
  }
  if (list.rolesManagedByIdp) {
    parts.push('Roles are managed by your identity provider: change one there. You can still deactivate someone here.')
  }
  return <p className="notice">{parts.join(' ')}</p>
}

/**
 * The link, the only time it exists anywhere but the admin's hands — the
 * server stores only its hash. Readonly rather than plain text so it can be
 * selected and copied on a phone, as an API key's secret can.
 */
function OneTimeLink({ link, onDismiss }: { link: ShownLink; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false)
  const what = link.purpose === 'invite' ? 'Invite link' : 'Reset link'

  function copy() {
    // Absent on plain-http origins other than localhost; the box always works.
    void navigator.clipboard?.writeText(link.url).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }

  return (
    <div className="notice notice-ok new-key" role="status">
      <p>
        {link.purpose === 'invite'
          ? `Send this link to ${link.email} by whatever channel you like. They set their own name and password with it.`
          : `Send this link to ${link.email}. Using it sets a new password and signs them out everywhere.`}
      </p>
      <label className="field">
        <span className="field-label">{`${what} for ${link.email}`}</span>
        <input className="new-key-secret" readOnly value={link.url} onFocus={(event) => event.target.select()} />
      </label>
      <p className="hint">{`It works once, and expires ${formatDateTime(link.expiresAt)}. It is not shown again.`}</p>
      <div className="settings-actions">
        <button type="button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  )
}
