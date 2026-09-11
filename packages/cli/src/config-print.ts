import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultConfig,
  loadDotEnv,
  parseConfigYaml,
  ravenclawHome,
  type ConfigFlags,
} from '@ravenclaw/core'

export function formatPublicConfig(opts?: { home?: string; flags?: ConfigFlags }): string {
  const home = opts?.home ?? ravenclawHome()
  const yamlText = existsSync(join(home, 'config.yaml'))
    ? readFileSync(join(home, 'config.yaml'), 'utf8')
    : undefined
  const parsed = yamlText === undefined ? {} : parseConfigYaml(yamlText)
  const fileEnv = loadDotEnv(
    existsSync(join(home, '.env')) ? readFileSync(join(home, '.env'), 'utf8') : '',
  )
  const base = defaultConfig()
  const flags = opts?.flags
  const provider =
    flags?.provider ??
    parsed.provider ??
    (fileEnv.ANTHROPIC_API_KEY ? 'anthropic' : undefined) ??
    (fileEnv.OLLAMA_HOST || fileEnv.OLLAMA_API_KEY ? 'ollama' : undefined) ??
    (fileEnv.VLLM_BASE_URL || fileEnv.VLLM_API_KEY ? 'vllm' : undefined) ??
    (fileEnv.OPENAI_API_KEY || fileEnv.OPENAI_BASE_URL ? 'openai_compat' : undefined) ??
    '(unset)'
  const model = flags?.model ?? parsed.model ?? base.model
  const permissionMode = flags?.dontAsk
    ? 'dontAsk'
    : (flags?.permissionMode ?? parsed.permissionMode ?? base.permissionMode)
  const mcp = parsed.mcp?.servers ?? base.mcp.servers
  const mcpLine =
    mcp.length === 0 ? '(none)' : mcp.map((server) => server.name).join(', ')
  const terminal = parsed.terminal?.backend ?? 'local'
  const image = parsed.terminal?.image
  const feed = parsed.ads?.feedUrl ?? ''
  const gateway = parsed.included?.gatewayUrl ?? ''

  return [
    `home: ${home}`,
    `provider: ${provider}`,
    `model: ${model}`,
    `permissionMode: ${permissionMode}`,
    `maxRounds: ${parsed.maxRounds ?? base.maxRounds}`,
    `childMaxRounds: ${parsed.childMaxRounds ?? base.childMaxRounds}`,
    `compact.enabled: ${parsed.compact?.enabled ?? base.compact.enabled}`,
    `compact.llmSummarize: ${parsed.compact?.llmSummarize ?? base.compact.llmSummarize}`,
    `ads.feedUrl: ${feed === '' ? '(empty)' : feed}`,
    `included.gatewayUrl: ${gateway === '' ? '(empty)' : gateway}`,
    `terminal: ${terminal}${image !== undefined && image !== '' ? ` (${image})` : ''}`,
    `mcp.servers: ${mcpLine}`,
    `ANTHROPIC_API_KEY: ${present(fileEnv.ANTHROPIC_API_KEY)}`,
    `OPENAI_API_KEY: ${present(fileEnv.OPENAI_API_KEY)}`,
    `OPENAI_BASE_URL: ${present(fileEnv.OPENAI_BASE_URL)}`,
    `OLLAMA_HOST: ${present(fileEnv.OLLAMA_HOST)}`,
    `VLLM_BASE_URL: ${present(fileEnv.VLLM_BASE_URL)}`,
  ].join('\n')
}

function present(value: string | undefined): string {
  if (value === undefined || value === '') return 'unset'
  return `set (${value.length} chars)`
}
