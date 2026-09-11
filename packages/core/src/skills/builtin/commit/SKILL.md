---
name: commit
description: Draft a conventional commit from the current diff. Do not push.
allowed-tools: [Read, Grep, Bash]
---

# commit

Prepare a local commit.

1. Inspect `git status` and `git diff` (and staged diff).
2. Do not add secrets, lockfile-only noise, or unrelated files.
3. Propose one short subject line in the repo's existing style (often `feat:`/`fix:`).
4. Only run `git add`/`git commit` if the user asked to commit. Never push unless asked.
