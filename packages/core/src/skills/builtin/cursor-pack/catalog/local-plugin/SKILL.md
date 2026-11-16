---
name: local-plugin
description: Add a local command tool with plugin.json.
---

# local-plugin

This skill is original RavenClaw prose. It is not an upstream copy.

A local plugin adds a command tool. The manifest is `plugin.json`.

Write it at either path:

- `.ravenclaw/plugins/<name>/plugin.json` in the project
- `~/.ravenclaw/plugins/<name>/plugin.json` for every project

The manifest has `name`, `description`, and `tools`. Each tool has `name`, `description`, `command`, and optional `args`. The command receives JSON on stdin and runs in the session cwd.

A plugin command is a leftover-ask. It does not run until the user accepts that ask.

Builtin tool names win. A plugin tool that reuses a builtin tool name is dropped, and the builtin stays.

Do not write a .cursor-plugin manifest. Do not add a marketplace entry.
