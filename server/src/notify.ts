/**
 * A lead that has just entered the pipeline: freshly submitted through an intake
 * form, or promoted out of the spam quarantine. Email (#11) and push (#13) hang
 * off the hook below.
 */
export interface CreatedLead {
  id: number
  /** Null for a lead whose form has since been deleted, or one created through REST. */
  formId: number | null
  isSpam: boolean
}

export type LeadCreatedHook = (lead: CreatedLead) => void

/**
 * Downstream effects, isolated from the response. A hook that throws — or one
 * that returns a promise which rejects — is logged and dropped: the lead is
 * already committed, and an SMTP outage is not the caller's problem to report.
 */
export function notifyLeadCreated(hook: LeadCreatedHook | undefined, lead: CreatedLead): void {
  if (hook === undefined) return
  try {
    const result = hook(lead) as unknown
    if (result instanceof Promise) result.catch(logHookFailure)
  } catch (error: unknown) {
    logHookFailure(error)
  }
}

function logHookFailure(error: unknown): void {
  console.error('lead-created hook failed', error)
}
