import { readPackageVersion } from '../package-version'

export interface McpRequestOpts {
  signal?: AbortSignal
}

export type McpTransportHealth = 'connecting' | 'ready' | 'dead'

export type McpRequestHandler = (method: string, params: unknown) => Promise<unknown>

export type McpElicitAction = 'accept' | 'decline' | 'cancel'

export interface McpElicitField {
  type: 'string' | 'number' | 'integer' | 'boolean'
  title?: string
  description?: string
  enum?: Array<string | number>
}

export interface McpElicitSchema {
  type: 'object'
  properties: Record<string, McpElicitField>
  required?: string[]
}

export interface McpElicitParams {
  message: string
  requestedSchema: McpElicitSchema
}

export interface McpElicitResult {
  action: McpElicitAction
  content?: Record<string, string | number | boolean>
}

export type McpElicitFn = (params: McpElicitParams, signal: AbortSignal) => Promise<McpElicitResult>

export interface McpTransport {
  request(method: string, params?: unknown, opts?: McpRequestOpts): Promise<unknown>
  notify?(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
  health?(): McpTransportHealth
  /** Server-initiated JSON-RPC (elicitation/create). Unset methods fail closed. */
  setRequestHandler?(handler: McpRequestHandler | undefined): void
}

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

export interface McpResource {
  uri: string
  name?: string
  mimeType?: string
  description?: string
  server?: string
}

export interface McpResourceContents {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpToolBridge {
  listTools(): Promise<McpToolDescriptor[]>
  callTool(name: string, input: unknown, opts?: McpRequestOpts): Promise<unknown>
  listResources(): Promise<McpResource[]>
  readResource(uri: string): Promise<McpResourceContents>
  close(): Promise<void>
}

export interface McpStdioStreams {
  stdin: {
    write(chunk: string | Uint8Array): unknown
    end?: () => void
  }
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
    off?(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  }
}

export const MCP_PROTOCOL_VERSION = '2025-03-26'

export const MCP_CLIENT_INFO = {
  name: 'ravenclaw',
  version: readPackageVersion(import.meta.url),
} as const
