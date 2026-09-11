export interface McpTransport {
  request(method: string, params?: unknown): Promise<unknown>
  close(): Promise<void>
}

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: unknown
}

export interface McpToolBridge {
  listTools(): Promise<McpToolDescriptor[]>
  callTool(name: string, input: unknown): Promise<unknown>
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
export const MCP_CLIENT_INFO = { name: 'ravenclaw', version: '0.1.3' } as const
