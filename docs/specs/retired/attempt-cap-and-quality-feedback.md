# Intent

Status: retired 2026-11-12 (implemented). This file is no longer a `check-spec` goal.

## Goal

The minimal executor continues a task when an attempt spends its tool-call budget and a later attempt is still allowed. The next prompt drops raw tool bodies and carries a short residue: paths already read or written, the last command outcome, and any current verification or quality-gate failure text, with the cap sentence in front. After a successful source write, quality-gate finding lines stay in the prompt as the pre-write result, including the re-run note. The capped attempt's transcript still records that attempt's tool calls.

## Non-goals

- Do not raise `MINIMAL_TOOL_CALL_CAP` above 150, the implementer `maxPromptTokens`, or the 24576-byte critic prompt ceiling.
- Do not complete a task because a filtered test exited 0. Verification still runs the task's allowlisted commands.
- Do not turn a wall-time stop or a `maxPromptTokens` stop into a later attempt. Both stay task-terminal on the attempt that hits them.
- Do not stop replacing feedback that starts with `AUDIT_REQUIRED` after a successful source write.
- Do not add a helper file, edit the implementer role JSON, or edit the implementer prompt.
- Do not change `MINIMAL_MAX_ATTEMPTS` or the rule that an explicit `maxSourceEditIterations` is 1 or 2.
- Do not add an attempt beyond that allowance for a second cap or a later verification failure.

## Owning context

`execution` in `@evelbulgroz/agent-sdlc`.

## Touched surfaces

- execution/minimal-executor.ts
- execution/minimal-executor.spec.mjs

## Invariants and constraints

- `MINIMAL_TOOL_CALL_CAP` stays 150. `MINIMAL_MAX_ATTEMPTS` stays 3. `MINIMAL_ATTEMPT_WALL_MS` stays 60 minutes.
- When the cap hits and `attempt` is below the attempt limit, `runAttempt` writes the transcript first, with `failureReason` `tool-calls` and the tool calls accumulated so far, then returns `done: false`. The next attempt builds its prompt from an empty tool-call list.
- That next feedback starts with `Attempt ended at the tool-call cap of 150. Raw tool results were dropped.` It then names each distinct path passed to `read_file`, `write_file`, `replace_in_file`, `replace_snapshot_range`, or `delete_file` in the dropped list. If that list contains a `run_allowlisted_command`, the feedback includes `Last command exit <code>` for the last such call and the first 200 characters of its stdout when stdout is a string. Feedback that starts with `quality-gate failed`, and other verification feedback that does not start with `AUDIT_REQUIRED`, follows that residue. The next prompt has no `### Tool results` block.
- A cap consumes one attempt from the same allowance as missing authored files, failed verification, and failed acceptance or checkpoint evidence. `execution/README.md` describes that allowance as the initial attempt plus two repairs.
- When the cap hits on the last attempt, `execute` returns `status` `failed`, `failureReason` `tool-calls`, and `attempts` equal to the attempt limit. No further model call runs inside that attempt.
- On a successful `write_file`, `replace_in_file`, `replace_snapshot_range`, or `delete_file`, feedback that starts with `quality-gate failed` is rewritten. Its first line is `Quality-gate findings below are the pre-write result.` The finding lines stay, including a jscpd line-restore instruction, and so does the line that starts `[note] quality-gate only re-evaluates`. The pre-write sentence is what tells the model the line-restore order is not the current order. Feedback that starts with `AUDIT_REQUIRED` is still replaced by `FILE_MODIFIED_FEEDBACK` from `execution/last-summary.ts`.
- A cap that continues sets `auditState.auditedDigest` to null and does not change `auditState.challenged`. The next complete runs verification. When `challenged` is already true, passing verification completes the task without another `AUDIT_REQUIRED` model turn. Leaving the digest set would let `finishAttempt` return `completed` before `runVerification` on an unchanged tree.
- A wall-time stop and a `maxPromptTokens` stop still return `done: true` on the attempt that hits them. The tests titled `@ac AC-07 @case AC-07.2 an injected 60 minute clock stops the attempt` and `@ac AC-07 @case AC-07.3 a prompt over the implementer ceiling is not sent` keep those titles and their failed-task assertions.
- The existing test titled `@ac AC-07 @case AC-07.1 the 150th tool call stops the attempt without another model call` keeps that title. It passes `maxSourceEditIterations: 1` and still asserts that the capped attempt makes no further model call. Its current body uses the default of three attempts.
- `note.txt` in AC-01 stays outside `authoredPaths`. `formatWorkingSetBlock` re-inlines authored paths only, and that block would otherwise embed `cap-sentinel-bytes`.
- Both authored files stay at or under 500 lines and 20480 bytes. The cap, residue, and feedback changes stay in `execution/minimal-executor.ts`. `execution/minimal-executor.ts` is 451 lines and 18727 bytes before this change. `execution/minimal-executor.spec.mjs` is 357 lines before this change.

## Public contract impact

None. `MINIMAL_TOOL_CALL_CAP`, `MINIMAL_MAX_ATTEMPTS`, and the implementer `maxPromptTokens` stay the same numbers. `execute` still returns `status`, `failureReason`, and `attempts`.

## Acceptance criteria

1. AC-01: A tool-call cap before the last attempt continues with a residue and without raw tool bodies. Given the default attempt limit, `authoredPaths` that do not include `note.txt`, a worktree file `note.txt` whose contents are `cap-sentinel-bytes`, a completion validator whose first result is `pass` false with the lines `quality-gate failed`, `[eslint] sonarjs/no-duplicate-string src/a.ts:1 - duplicate (abcd)`, and `[note] quality-gate only re-evaluates when you emit {"kind":"complete","summary":"..."}. Once your edits and test runs pass, declare complete to re-run quality-gate.`, and a script of one complete, then one `run_allowlisted_command` whose result exit code is 1 and whose stdout is `cmd-sentinel-outcome`, then 149 `read_file` calls on `note.txt`, then one complete whose validator result is `pass` false. Then the governor prompt for that last complete contains `Attempt ended at the tool-call cap of 150. Raw tool results were dropped.` before `note.txt`, `Last command exit 1`, `cmd-sentinel-outcome`, `quality-gate failed`, and `sonarjs/no-duplicate-string`, and that prompt does not contain `### Tool results` or `cap-sentinel-bytes`. The attempt 2 transcript records `failureReason` `tool-calls` and includes those 149 reads. `execute` returns status `failed` and attempts 3.
2. AC-02: A tool-call cap on the last attempt fails the task and the cap stays 150. Given `maxSourceEditIterations` 1 and a script of 150 `read_file` calls on `note.txt`. Then `execute` returns status `failed`, `failureReason` `tool-calls`, and attempts 1, the governor is called 150 times, and `MINIMAL_TOOL_CALL_CAP` is 150.
3. AC-03: Quality-gate findings stay as the pre-write result, including the re-run note. Given `maxSourceEditIterations` 2, a completion validator whose first result is `pass` false with the lines `quality-gate failed`, `[eslint] sonarjs/no-duplicate-string src/a.ts:1 - duplicate (abcd)`, `[jscpd] clone src/a.ts:4-6 — baseline clone at src/a.ts:1-3 shifted to lines 4-6. Keep lines 1-3 at their original line numbers (place new imports after line 3).`, and `[note] quality-gate only re-evaluates when you emit {"kind":"complete","summary":"..."}. Once your edits and test runs pass, declare complete to re-run quality-gate.`, and a script of complete, then `write_file` of `src/note.txt`, then complete. Then the governor prompt after that write contains `Quality-gate findings below are the pre-write result.` before `sonarjs/no-duplicate-string`, `Keep lines 1-3`, and `[note] quality-gate only re-evaluates`, and that prompt does not equal `FILE_MODIFIED_FEEDBACK`.
4. AC-04: AUDIT_REQUIRED feedback is still replaced after a source write, and a continued cap clears the audit digest. Given `auditGate` true. Then a write replaces an `AUDIT_REQUIRED` body, and a cap before the last attempt makes the next complete run verification. Cases: AC-04.1: `maxSourceEditIterations` 1 and a script of complete, then `write_file` of `src/note.txt`, then complete, and the prompt after that write contains `Previous check reported an issue, and a file has since been modified` and does not contain `candidateDigest`; AC-04.2: `maxSourceEditIterations` 2, the first complete passes verification and sets the audit challenge, the next 150 `read_file` calls do not change the worktree, and the following complete passes verification. The completion validator runs on both completes, the governor is called 152 times, and `execute` returns status `completed` and attempts 2.
5. AC-05: The executor and its spec stay within the navigability budget. Given `execution/minimal-executor.ts` and `execution/minimal-executor.spec.mjs` after the change. Then each file is at most 500 lines and at most 20480 bytes.

## Failure defenses

- A cap on the last attempt returns `tool-calls` and does not start another model call.
- An empty governor script on the attempt after a continued cap throws `GOVERNOR_ROUTES_EXHAUSTED` and the task result is `failed`. It does not report `completed`.
- A wall-time stop and a `maxPromptTokens` stop still fail the task on that attempt when later attempts remain.
- Replacing `quality-gate failed` with `FILE_MODIFIED_FEEDBACK`, or dropping the `[note] quality-gate only re-evaluates` line, fails AC-03.
- Leaving an `AUDIT_REQUIRED` body in the prompt after a successful write fails AC-04.1. A post-cap complete that skips verification fails AC-04.2.
- A prompt that lacks the cap residue, or that contains `cap-sentinel-bytes` or `### Tool results`, fails AC-01. Status `completed` on that empty prompt does not satisfy AC-01.
- A second helper file, or either authored file over 500 lines or 20480 bytes, fails AC-05.

## Verification plan

- `execution/minimal-executor.spec.mjs` cites AC-01, AC-02, AC-03, AC-04, and AC-05. Each citation has an `assert`. AC-04 cites AC-04.1 and AC-04.2. AC-05 reads the two authored files and asserts line count and byte length.
- The task command is `pnpm run test:unit`.
- Package done bar after implementation: `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`.

## Unresolved questions

_None_

## Assumptions

- The continuation feedback sentence is exactly `Attempt ended at the tool-call cap of 150. Raw tool results were dropped.`
- The pre-write sentence is exactly `Quality-gate findings below are the pre-write result.`
- `FILE_MODIFIED_FEEDBACK` in `execution/last-summary.ts` stays the sentence that begins `Previous check reported an issue, and a file has since been modified`.
- The fake governor stores each request prompt on `governor.calls` and throws `GOVERNOR_ROUTES_EXHAUSTED` when its script is empty.
- The host run's `status.json` and attempt artifacts are no longer on disk. A recorded read of the deleted fetch-sweep artifacts `f6b6303787de5ea3313387136d6835bb7dbc4bd6c70c7fefff9c9f8809239b09.json` and `22ad62ecfa63d8c01439a740e03d8ba9e13e9646b492c6c6f62bf20006726aa4.json` showed attempt 1 `verification-failed` with 39 tool calls and attempt 2 `tool-calls` with 188 tool calls. The 188 count is the shared array. The per-attempt cap remains 150. The surviving model-usage diagnostic for that task is attempt 1 step 31 and does not record the halt.
- The earlier quality-gate finding lines were not retained in a surviving artifact. The wipe is the successful-write branch in `execution/minimal-executor.ts` that replaces feedback matching `/^quality-gate failed|^AUDIT_REQUIRED/`.
- No ADR is offered. The attempt budget and the cap number stay as they are.
