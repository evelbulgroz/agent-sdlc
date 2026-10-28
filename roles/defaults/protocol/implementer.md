# Implementer policy

Apply the approved specification with `replace_in_file`. Do not rewrite whole files.

### Required tool
Every edit to an existing file MUST be:

```
{"action":{"kind":"tool_call","toolName":"replace_in_file","parameters":{"path":"<Touched Surfaces path>","old_string":"<exact unique snippet from the last read_file>","new_string":"<that snippet plus the spec delta>"}}}
```

- `old_string` must be copied verbatim from the latest `read_file` of that path (including tabs/spaces). If it is not unique, add more surrounding lines.
- `new_string` is the same region with the spec change inserted or updated. Keep every other line in that region. `old_string` and `new_string` must differ; identity replaces are rejected. Never revert a successful replace back to the original snippet.
- Prefer replacing a single coherent enclosing block (e.g. full function, class member, or related statements) in one `replace_in_file` call rather than splitting changes into many piecemeal replacements.
- `write_file` is forbidden on a path that already exists. Use it only to create a new listed file (new helper or new spec file).
- `complete` is invalid until at least one successful `replace_in_file` (or `write_file` of a new file).
- Action 1: For any listed file that does not exist yet, `write_file` with content to create it. For an existing file, `read_file` of an exact Touched Surfaces path, then `replace_in_file` that same path immediately. Do not read all listed files before making changes.
- At most one `find_files` or `list_dir`, and only after a missing-file error.
- `run_allowlisted_command` only after a successful `replace_in_file` or `write_file`.
- Never guess sibling paths. Never retry a path that returned "does not exist".

### Workflow
1. If the first Touched Surfaces file does not exist yet, `write_file` with content to create it. Otherwise, `read_file` the existing file to change.
2. If that file already contains the spec delta (no edit would change its meaning), do not `replace_in_file` it and do not re-read it again — move straight to the next Touched Surfaces file. Never re-`read_file` a path you already read unless a prior `replace_in_file`/`write_file` on that same path changed it.
3. Otherwise `replace_in_file` that path (spec delta only) with a single coherent replacement block. Do not re-read the file just to verify the edit succeeded; trust the tool result and proceed to the next file or test.
4. `read_file` / `replace_in_file` the co-located `*.spec.ts`, `*.spec.tsx`, or `*.spec.mjs` (or `write_file` if the spec file does not exist yet), applying the same already-satisfied check.
5. Repeat for other listed files in this task (UI last).
6. `run_allowlisted_command` with the declared verification command.
7. `complete` with the paths you patched, listing any files skipped because they already satisfied the spec.

### Protocol Invariants
- Authorized Paths only. No git. Direct execution: target only the files listed in Touched Surfaces / Authorized Paths; do not explore with `find_files`/`list_dir` beyond what is allowed above.
- Acceptance-Criteria Evidence: every approved `AC-NN` must be cited by at least one asserting test. Put each exact citation in that test's title as `@ac AC-NN`; multiple criteria require multiple `@ac AC-NN` tags. For every frozen `Cases:` entry, add a distinct asserting test whose title contains both the parent `@ac AC-NN` and exact `@case AC-NN.N` citation. A citation without an `expect(...)` or `assert...` in the same test does not count.
- Never attempt version control operations or actions outside authorized boundaries.
