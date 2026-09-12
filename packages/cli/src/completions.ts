export const COMPLETION_COMMANDS = [
  'exec',
  'acp',
  'setup',
  'smoke',
  'sessions',
  'show',
  'rm',
  'resume',
  'search',
  'export',
  'title',
  'doctor',
  'config',
  'init',
  'completions',
  'mcp',
  'skills',
  'cron',
  'serve',
  'slack',
  'help',
  'version',
] as const

export function bashCompletions(): string {
  const cmds = COMPLETION_COMMANDS.join(' ')
  return [
    '# raven bash completion',
    '_raven() {',
    '  local cur prev',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  local cmds="${cmds}"`,
    '  local opts="--help --version --provider --model --tui --dont-ask --json --all"',
    '  if [[ ${COMP_CWORD} -eq 1 ]]; then',
    '    COMPREPLY=( $(compgen -W "${cmds} ${opts}" -- "${cur}") )',
    '    return 0',
    '  fi',
    '  case "${prev}" in',
    '    --provider) COMPREPLY=( $(compgen -W "anthropic openai_compat ollama vllm" -- "${cur}") ) ;;',
    '    --tui) COMPREPLY=( $(compgen -W "ink opentui" -- "${cur}") ) ;;',
    '    completions) COMPREPLY=( $(compgen -W "bash zsh" -- "${cur}") ) ;;',
    '    *) COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") ) ;;',
    '  esac',
    '}',
    'complete -F _raven raven',
    '',
  ].join('\n')
}

export function zshCompletions(): string {
  const cmds = COMPLETION_COMMANDS.join(' ')
  return `#compdef raven
_arguments -C \\
  '1:command:(${cmds})' \\
  '--provider[provider]:provider:(anthropic openai_compat ollama vllm)' \\
  '--model[model id]' \\
  '--tui[ui]:ui:(ink opentui)' \\
  '--dont-ask[skip permission prompts]' \\
  '--json[JSONL events for exec]' \\
  '--all[search every session]' \\
  '--help[help]' \\
  '--version[version]'
`
}

export function completionsScript(shell: string): { text: string } | { error: string } {
  const key = shell.trim().toLowerCase()
  if (key === 'bash') return { text: bashCompletions() }
  if (key === 'zsh') return { text: zshCompletions() }
  return { error: 'usage: raven completions bash|zsh' }
}
