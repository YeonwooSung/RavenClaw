import { describe, expect, test } from 'bun:test'
import {
  createMemoryStore,
  createSessionEngine,
  getModelProfile,
  type CompactPolicy,
  type ProviderChunk,
  type SessionRecord,
} from '@ravenclaw/core'
import { normalizeOpenAiBaseUrl } from '@ravenclaw/core'
import { AnthropicMessagesProvider } from './anthropic'
import { OpenAICompatProvider } from './openai-compat'
import { createProvider } from './registry'

const openaiKey = process.env.OPENAI_API_KEY
const anthropicKey = process.env.ANTHROPIC_API_KEY
const ollamaHost = process.env.OLLAMA_HOST
const ollamaModel = process.env.OLLAMA_MODEL ?? 'llama3.2'
const vllmBaseUrl = process.env.VLLM_BASE_URL
const vllmModel = process.env.VLLM_MODEL ?? 'local-model'

const compact: CompactPolicy = {
  enabled: false,
  autoCompactBuffer: 13_000,
  blockingBufferWhenManual: 3_000,
  protectLastMessages: 20,
  keepRecentFiles: 5,
  maxCharsPerRestoredFile: 5_000,
  maxCharsRestoredFilesTotal: 50_000,
  maxCharsPerRestoredSkill: 5_000,
  maxCharsRestoredSkillsTotal: 25_000,
  maxConsecutiveFailures: 3,
  llmSummarize: false,
}

function session(model: string): SessionRecord {
  return {
    id: 'live_sess',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cwd: process.cwd(),
    model,
    permissionMode: 'dontAsk',
    compactGeneration: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    funding: 'byok',
  }
}

async function collectStream(stream: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('env-gated live providers', () => {
  test.skipIf(!openaiKey)(
    'OpenAI stream() text-only when OPENAI_API_KEY is set',
    async () => {
      const provider = new OpenAICompatProvider({ apiKey: openaiKey as string })
      const chunks = await collectStream(
        provider.stream(
          {
            model: 'gpt-4o-mini',
            system: [{ tier: 'stable', text: 'Reply with the single word pong.' }],
            messages: [
              {
                id: 'u1',
                role: 'user',
                blocks: [{ type: 'text', text: 'ping' }],
                createdAt: Date.now(),
              },
            ],
            tools: [],
            maxTokens: 32,
          },
          new AbortController().signal,
        ),
      )
      const text = chunks
        .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
        .map((c) => c.text)
        .join('')
      expect(text.length).toBeGreaterThan(0)
      expect(chunks.some((c) => c.type === 'stop')).toBe(true)
    },
    30_000,
  )

  test.skipIf(!anthropicKey)(
    'Anthropic queryLoop text-only when ANTHROPIC_API_KEY is set',
    async () => {
      const modelId = 'claude-3-5-haiku-latest'
      const provider = new AnthropicMessagesProvider({ apiKey: anthropicKey as string })
      const store = createMemoryStore()
      const rec = session(modelId)
      await store.createSession(rec)
      const engine = await createSessionEngine({
        session: rec,
        provider,
        store,
        tools: [],
        compact,
        model: { ...getModelProfile(modelId), id: modelId },
        maxRounds: 1,
        async askUser() {
          return 'deny'
        },
      })
      const events: Array<{ type: string }> = []
      const gen = engine.submitMessage('Reply with the single word pong.')
      while (true) {
        const next = await gen.next()
        if (next.done) {
          expect(next.value.reason).toBe('completed')
          break
        }
        events.push(next.value)
      }
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { type: 'text_delta'; text: string }).text)
        .join('')
      expect(text.length).toBeGreaterThan(0)
    },
    30_000,
  )

  test.skipIf(!ollamaHost)(
    'Ollama stream() text-only when OLLAMA_HOST is set',
    async () => {
      const provider = createProvider({
        provider: 'ollama',
        apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
        baseUrl: normalizeOpenAiBaseUrl(ollamaHost as string),
        defaultModel: ollamaModel,
      })
      const chunks = await collectStream(
        provider.stream(
          {
            model: ollamaModel,
            system: [{ tier: 'stable', text: 'Reply with the single word pong.' }],
            messages: [
              {
                id: 'u1',
                role: 'user',
                blocks: [{ type: 'text', text: 'ping' }],
                createdAt: Date.now(),
              },
            ],
            tools: [],
            maxTokens: 32,
          },
          new AbortController().signal,
        ),
      )
      const text = chunks
        .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
        .map((c) => c.text)
        .join('')
      expect(text.length).toBeGreaterThan(0)
      expect(chunks.some((c) => c.type === 'stop')).toBe(true)
    },
    60_000,
  )

  test.skipIf(!vllmBaseUrl)(
    'vLLM stream() text-only when VLLM_BASE_URL is set',
    async () => {
      const provider = createProvider({
        provider: 'vllm',
        apiKey: process.env.VLLM_API_KEY ?? 'vllm',
        baseUrl: normalizeOpenAiBaseUrl(vllmBaseUrl as string),
        defaultModel: vllmModel,
      })
      const chunks = await collectStream(
        provider.stream(
          {
            model: vllmModel,
            system: [{ tier: 'stable', text: 'Reply with the single word pong.' }],
            messages: [
              {
                id: 'u1',
                role: 'user',
                blocks: [{ type: 'text', text: 'ping' }],
                createdAt: Date.now(),
              },
            ],
            tools: [],
            maxTokens: 32,
          },
          new AbortController().signal,
        ),
      )
      const text = chunks
        .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
        .map((c) => c.text)
        .join('')
      expect(text.length).toBeGreaterThan(0)
      expect(chunks.some((c) => c.type === 'stop')).toBe(true)
    },
    60_000,
  )
})
