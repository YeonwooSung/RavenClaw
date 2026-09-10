import { Box, Text } from 'ink'

export function Composer(props: { value: string; busy: boolean; notice?: string }) {
  return (
    <Box flexDirection="column">
      {props.notice ? <Text dimColor>{props.notice}</Text> : null}
      <Box>
        <Text>{props.busy ? '… ' : '> '}</Text>
        <Text>{props.value}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  )
}
