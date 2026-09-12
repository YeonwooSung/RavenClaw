import { Box, Text } from 'ink'
import type { TaskSnapshot } from '@ravenclaw/core'

export function agentTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  return tasks.filter((task) => task.type === 'agent')
}

export function formatChildAgentLine(task: TaskSnapshot): string | undefined {
  if (task.type !== 'agent') return undefined
  return `agent ${task.id.slice(0, 8)} ${task.status} ${task.description}`
}

export function ChildAgentList(props: { tasks: TaskSnapshot[] }) {
  const children = agentTasks(props.tasks)
  if (children.length === 0) return null
  return (
    <Box flexDirection="column">
      {children.map((task) => {
        const line = formatChildAgentLine(task)
        if (line === undefined) return null
        return (
          <Text key={task.id} dimColor>
            {line}
          </Text>
        )
      })}
    </Box>
  )
}
