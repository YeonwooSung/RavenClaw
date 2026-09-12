import { forkMemoryReview } from '@ravenclaw/core'
import { compactPolicyFromConfig, type CliRuntime } from './engine'

export async function runSessionReview(
  runtime: CliRuntime,
  prompt: string,
  fork: typeof forkMemoryReview = forkMemoryReview,
): Promise<string> {
  const result = await fork({
    provider: runtime.provider,
    store: runtime.store,
    session: runtime.engine.session,
    model: runtime.config.profile,
    compact: compactPolicyFromConfig(runtime.config.compact),
    text: prompt,
  })
  if (!result.ok) return `review failed: ${result.text}`
  if (!result.path) return 'review produced no memory to write'
  return `wrote ${result.path}`
}
