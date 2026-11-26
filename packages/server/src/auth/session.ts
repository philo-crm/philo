/** ADR-0012. A user works leads; an admin also configures the instance and manages people. */
export type Role = 'user' | 'admin'

/** A person with access, as every route that needs one sees them. */
export interface SessionUser {
  id: number
  email: string
  name: string | null
  role: Role
}
