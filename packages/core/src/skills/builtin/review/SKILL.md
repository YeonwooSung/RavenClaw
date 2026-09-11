---
name: review
description: Review recent edits for bugs, regressions, and missing tests. Read-only.
allowed-tools: [Read, Grep, Glob, ListDir, ReadSubtree]
---

# review

Review the latest uncommitted or just-written changes.

1. Identify the files that changed this session (diff, git status, or conversation).
2. Read those files. Do not edit.
3. Report findings first: severity, file path, why it matters.
4. If nothing to flag, say so in one line.
5. Do not invent issues. Do not commit.
