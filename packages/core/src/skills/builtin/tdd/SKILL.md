---
name: tdd
description: Red-green-refactor. Write a failing test first.
allowed-tools: [Read, Grep, Glob, Edit, Write, ApplyPatch, Bash]
---

# tdd

1. Write one failing test that names the desired behavior.
2. Run it and confirm it fails for the right reason.
3. Write the smallest code that makes it pass.
4. Re-run that test. Then clean up only if needed.
5. Do not add extra features in the green step.
