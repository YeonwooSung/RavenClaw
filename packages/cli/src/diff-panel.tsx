import { Box, Text } from 'ink'
import { formatDiffPanel, type GitDiffView } from './diff-cmd'

export function DiffPanel(
  props: { view: GitDiffView; selected: number } | { lines: string[] },
) {
  const lines = 'lines' in props ? props.lines : formatDiffPanel(props.view, props.selected)
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} inverse={line.startsWith('>')}>
          {line}
        </Text>
      ))}
    </Box>
  )
}
