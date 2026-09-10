import type {
  CompactPolicy,
  ModelProfile,
  Provider,
  ProviderRequest,
  SessionRecord,
  SessionStore,
} from '../types'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'Bash'])

export interface ForkMemoryReviewOpts {
  provider: Provider
  store: SessionStore
  session: SessionRecord
  model: ModelProfile
  compact: CompactPolicy
  text: string
}

export async function forkMemoryReview(
  opts: ForkMemoryReviewOpts,
): Promise<{ ok: boolean; text: string }> {
  try {
    const req: ProviderRequest = {
      model: opts.model.id,
      system: [
        {
          tier: 'stable',
          text: 'Read-only memory review. You cannot call Edit, Write, or Bash.',
        },
      ],
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [{ type: 'text', text: opts.text }],
          createdAt: Date.now(),
        },
      ],
      tools: [],
      maxTokens: opts.model.reserveOutputTokens,
    }
    let text = ''
    const abort = new AbortController()
    for await (const chunk of opts.provider.stream(req, abort.signal)) {
      if (chunk.type === 'text_delta') text += chunk.text
      if (chunk.type === 'tool_call' && MUTATING_TOOLS.has(chunk.name)) continue
    }
    return { ok: true, text }
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : 'review failed',
    }
  }
}
