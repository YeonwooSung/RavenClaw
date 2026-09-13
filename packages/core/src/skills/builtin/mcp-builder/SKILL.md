---
name: mcp-builder
description: Write a local MCP server this CLI can load.
allowed-tools: [Read, Grep, Glob, Edit, Write, ApplyPatch, Bash]
---

# mcp-builder

Use when the user wants a new MCP server for this workspace.

1. Prefer stdio transport. Register the server in RavenClaw config (`mcp.servers`) with a stable `name` plus stdio `command` (and `args` if needed); default type is stdio.
2. One tool = one job. Give each tool a clear name, description, and a required input schema.
3. Implement the smallest server that lists and handles those tools. Keep secrets out of skill text and onboarding scan JSON (name + transport only in scans).
4. Wire config only through RavenClaw config docs / `config.yaml` — never invent a marketplace or install channel.
5. Verify with `/mcp` (and config docs) after reload; fix spawn or schema errors before adding more tools.
