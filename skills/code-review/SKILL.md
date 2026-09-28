---
name: code-review
description: Review code for correctness, clarity, and tests. Use when asked to review code or a pull request.
---

# Code Review

1. Read the changed code and its tests.
2. Flag correctness bugs first, then clarity, then style.
3. Suggest a concrete fix or test for each finding.
4. Summarize with a short verdict: approve, approve with nits, or request changes.

## Tools

You have file and shell tools. Prefer `read_file` to load code and tests
before commenting, `grep` to find usages, and `bash` to run the relevant
test suite. `write_file` overwrites existing files only — it cannot create
new files. Skill `scripts/` helpers (if any) run via `bash`.
