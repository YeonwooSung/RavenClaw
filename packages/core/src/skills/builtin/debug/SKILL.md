---
name: debug
description: Diagnose a failing test or error before changing code.
allowed-tools: [Read, Grep, Glob, Bash, ListDir]
---

# debug

Find the cause before editing.

1. Reproduce: run the failing command and capture the exact error.
2. Locate the first stack frame in this repo.
3. Read that code and the nearest test.
4. State the hypothesis in one sentence, then confirm or reject it with evidence.
5. Only then propose a minimal fix.
