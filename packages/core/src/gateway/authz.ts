export interface AuthzOpts {
  allowedUsers?: string[]
  allowAll?: boolean
}

export function isUserAllowed(userId: string, opts: AuthzOpts): boolean {
  if (opts.allowAll === true) return true
  const allowed = opts.allowedUsers ?? []
  if (allowed.length === 0) return false
  return allowed.includes('*') || allowed.includes(userId)
}
