import { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import {
  createRotationState,
  fetchAds,
  layoutDock,
  markActivity,
  recordImpression,
  sanitizeAdUrl,
  shouldRotate,
  type AdCreative,
} from '@ravenclaw/ads'

const DEFAULT_COMPOSER_ROWS = 3
const ROTATE_TICK_MS = 1_000

export function adOpenCommand(platform = process.platform): [string] | undefined {
  if (platform === 'darwin') return ['open']
  if (platform === 'linux') return ['xdg-open']
  return undefined
}

export function openCreativeUrl(
  url: string,
  opts?: { platform?: NodeJS.Platform; spawn?: (cmd: string[]) => void },
): boolean {
  const safe = sanitizeAdUrl(url)
  if (safe === null) return false
  const cmd = adOpenCommand(opts?.platform ?? process.platform)
  if (cmd === undefined) return false
  try {
    const spawn = opts?.spawn ?? defaultSpawn
    spawn([...cmd, safe])
    return true
  } catch {
    return false
  }
}

function linkifyDockLine(line: string, url: string): string {
  const safe = sanitizeAdUrl(url)
  if (safe === null) return line
  return `\u001b]8;;${safe}\u0007${line}\u001b]8;;\u0007`
}

function defaultSpawn(cmd: string[]): void {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    proc.unref()
  } catch {
    // dock clicks must never crash the TUI or tests
  }
}

export function AdDock(props: {
  enabled: boolean
  feedUrl: string
  sessionId: string
  composerReservedRows?: number
  hasPaidCapacityPlan?: boolean
}) {
  const { stdout } = useStdout()
  const width = stdout?.columns || 80
  const termHeight = stdout?.rows || 24
  const reserved = props.composerReservedRows ?? DEFAULT_COMPOSER_ROWS
  const rotation = useRef(createRotationState())
  const [creative, setCreative] = useState<AdCreative | undefined>(undefined)
  const creativeRef = useRef(creative)
  creativeRef.current = creative

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const req: Parameters<typeof fetchAds>[0] = {
        enabled: props.enabled,
        feedUrl: props.feedUrl,
        sessionId: props.sessionId,
        hasPaidCapacityPlan: props.hasPaidCapacityPlan === true,
      }
      const placement = await fetchAds(req)
      if (cancelled) return
      setCreative(placement.creative)
      recordImpression(rotation.current, placement.creative.id, Date.now())
    }
    void load()
    const timer = setInterval(() => {
      if (shouldRotate(rotation.current, Date.now())) void load()
    }, ROTATE_TICK_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [props.enabled, props.feedUrl, props.sessionId, props.hasPaidCapacityPlan])

  useInput((_input, key) => {
    markActivity(rotation.current, Date.now())
    if (key.return && creativeRef.current) {
      openCreativeUrl(creativeRef.current.url)
    }
  })

  if (!creative) return null
  const dock = layoutDock(width, termHeight, creative, reserved)
  if (!dock.opened) return null

  return (
    <Box flexDirection="column">
      {dock.lines.map((line, index) => (
        <Text key={index}>{linkifyDockLine(line, creative.url)}</Text>
      ))}
    </Box>
  )
}
