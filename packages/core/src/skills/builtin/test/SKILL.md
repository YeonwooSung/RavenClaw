---
name: test
description: Add or run the smallest tests that cover the change.
allowed-tools: [Read, Grep, Glob, Edit, Write, ApplyPatch, Bash]
---

# test

Prove the change with tests.

1. Find the existing test runner and nearby tests.
2. Add or update the smallest test that would have failed before the fix.
3. Run only that suite. Do not start a full unrelated matrix.
4. If a test fails, fix the code or the test, then re-run.
5. Report the command and the pass/fail line.
