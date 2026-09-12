import { Box, Text } from 'ink'
import type { TodoItem } from '@ravenclaw/core'

export function formatTodoLines(items: TodoItem[]): string[] {
  if (items.length === 0) return []
  return items.map(formatTodoLine)
}

export function formatTodoLine(item: TodoItem): string {
  return `${item.id ?? '-'} ${item.status} ${item.text}`
}

export function TodoPanel(props: { items: TodoItem[] }) {
  const lines = formatTodoLines(props.items)
  if (lines.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      {props.items.map((item, index) => (
        <Text key={item.id ?? `todo:${index}`} dimColor={item.status === 'done'}>
          {lines[index]}
        </Text>
      ))}
    </Box>
  )
}
