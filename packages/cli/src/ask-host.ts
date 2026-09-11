import { formatAskUserPrompt, type AskUserFn, type AskUserInput } from '@ravenclaw/core'

const INVALID = 'AskUser: invalid choice'
const REPLY_HINT = 'reply with a/b or 1/2'

export interface AskUserBridge {
  ask(input: AskUserInput, signal: AbortSignal): Promise<string>
  bind(fn: AskUserFn): void
}

export function parseAskUserAnswer(input: AskUserInput, line: string): string {
  const questions = input.questions
  if (questions.length === 0) return INVALID

  const segments = splitAnswerSegments(questions, line)
  if (segments === undefined || segments.length !== questions.length) return INVALID

  const lines: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    const segment = segments[i]
    if (question === undefined || segment === undefined) return INVALID
    const labels = resolveQuestion(question, segment)
    if (labels === undefined) return INVALID
    const tag = `Q${i + 1}`
    for (const label of labels) lines.push(`${tag}: ${label}`)
  }
  return lines.length === 0 ? INVALID : lines.join('\n')
}

export function formatAskUserDialog(input: AskUserInput): string {
  return `${formatAskUserPrompt(input)}\n\n${REPLY_HINT}`
}

export function createAskUserBridge(): AskUserBridge {
  let impl: AskUserFn | undefined
  return {
    async ask(input, signal) {
      if (signal.aborted) throw abortError()
      if (!impl) return formatAskUserPrompt(input)
      return impl(input, signal)
    },
    bind(fn) {
      impl = fn
    },
  }
}

type AskQuestion = AskUserInput['questions'][number]

function splitAnswerSegments(questions: AskQuestion[], line: string): string[] | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  if (questions.length === 1) return [trimmed]
  if (trimmed.includes('\n')) return trimmed.split('\n').map((part) => part.trim())
  if (trimmed.includes(';')) return trimmed.split(';').map((part) => part.trim())
  if (!questions.some((question) => question.multiSelect === true)) {
    return trimmed.split(',').map((part) => part.trim())
  }
  return [trimmed]
}

function resolveQuestion(question: AskQuestion, segment: string): string[] | undefined {
  const tokens =
    question.multiSelect === true
      ? segment
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
      : [segment.trim()]
  if (tokens.length === 0) return undefined
  if (question.multiSelect !== true && tokens.length !== 1) return undefined

  const labels: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const label = resolveToken(question, token)
    if (label === undefined) return undefined
    if (seen.has(label)) continue
    seen.add(label)
    labels.push(label)
  }
  return labels.length === 0 ? undefined : labels
}

function resolveToken(question: AskQuestion, token: string): string | undefined {
  if (/^[a-z]$/i.test(token)) {
    const index = token.toLowerCase().charCodeAt(0) - 97
    return question.options[index]?.label
  }
  if (/^[1-9]\d*$/.test(token)) {
    const index = Number(token) - 1
    return question.options[index]?.label
  }
  const needle = token.toLowerCase()
  return question.options.find((option) => option.label.toLowerCase() === needle)?.label
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}
