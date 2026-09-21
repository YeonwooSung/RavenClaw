import { Box, Text } from 'ink'
import type { PendingAskAnswer, StreamEvent } from '@ravenclaw/core'

export type PermissionAsk = Extract<StreamEvent, { type: 'permission_ask' }>

export function permissionAskChildLabel(event: PermissionAsk): string | undefined {
  return event.childSessionId ? `child ${event.childSessionId}` : undefined
}

export function PermissionDialog(props: { event: PermissionAsk }) {
  const childLabel = permissionAskChildLabel(props.event)
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Allow {props.event.tool}?</Text>
      {childLabel ? <Text>{childLabel}</Text> : null}
      <Text>{props.event.message}</Text>
      <Text dimColor>y allow   n deny   a always   i skip   esc abort</Text>
    </Box>
  )
}

export function keyToPermission(
  input: string,
): PendingAskAnswer | undefined {
  if (input === 'y' || input === 'Y') return 'allow'
  if (input === 'n' || input === 'N') return 'deny'
  if (input === 'a' || input === 'A') return 'allow_always'
  if (input === 'i' || input === 'I') return 'ignored'
  return undefined
}
