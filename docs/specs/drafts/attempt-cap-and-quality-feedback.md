# Intent

## Goal

The minimal executor keeps a task alive when an attempt spends its tool-call budget and a later attempt is still allowed, and it keeps quality-gate finding text in the next prompt after a source write. The failed attempt's transcript still records that attempt's tool calls. The next attempt's prompt is built from an empty tool-call list and a short cap sentence, so the new prompt does not replay the prior transcript.

## Non-goals

- Do not raise `MINIMAL_TOOL_CALL_CAP` above 150, the implementer `maxPromptTokens`, or the 24576-byte critic prompt ceiling.
- Do not complete a task because a filtered test exited 0. Verification still runs the task's allowlisted commands.
- Do not turn a wall-time stop or a `maxPromptTokens` stop into a later attempt. Both stay task-terminal on the attempt that hits them.
- Do not stop replacing feedback that starts with `AUDIT_REQUIRED` after a successful source write.
- Do not add a helper file, edit the implementer role JSON, or edit the implementer prompt.
- Do not change `MINIMAL_MAX_ATTEMPTS` or the rule that an explicit `maxSourceEditIterations` is 1 or 2.

## Owning context

`execution` in `@evelbulgroz/agent-sdlc`.

## Touched surfaces

- execution/minimal-executor.ts
- execution/minimal-executor.spec.mjs

## Invariants and constraints

- `MINIMAL_TOOL_CALL_CAP` stays 150. `MINIMAL_MAX_ATTEMPTS` stays 3. `MINIMAL_ATTEMPT_WALL_MS` stays 60 minutes.
- When the cap hits and `attempt` is below the attempt limit, `runAttempt` returns `done: false` with feedback `Attempt ended at the tool-call cap of 150. Continue the task. Earlier tool results from this task are not in this prompt.` The next attempt builds its prompt from an empty tool-call list. The capped attempt's transcript still stores that attempt's tool calls and `failureReason` `tool-calls`.
- When the cap hits on the last attempt, `execute` returns `status` `failed`, `failureReason` `tool-calls`, and `attempts` equal to the attempt limit. No further model call runs inside that attempt.
- Feedback that starts with `quality-gate failed` stays in place after a successful source write, including its later finding lines. Feedback that starts with `AUDIT_REQUIRED` is still replaced by `FILE_MODIFIED_FEEDBACK` from `execution/last-summary.ts`.
- A wall-time stop and a `maxPromptTokens` stop still return `done: true` on the attempt that hits them. The tests titled `@ac AC-07 @case AC-07.2 an injected 60 minute clock stops the attempt` and `@ac AC-07 @case AC-07.3 a prompt over the implementer ceiling is not sent` keep those titles and their failed-task assertions.
- The existing test titled `@ac AC-07 @case AC-07.1 the 150th tool call stops the attempt without another model call` keeps that title. It passes `maxSourceEditIterations: 1` and still asserts that the capped attempt makes no further model call.
- Both authored files stay at or under 500 lines and 20480 bytes. The cap and feedback changes stay in the existing branches of `execution/minimal-executor.ts`.

## Public contract impact

None. `MINIMAL_TOOL_CALL_CAP`, `MINIMAL_MAX_ATTEMPTS`, and the implementer `maxPromptTokens` stay the same numbers. `execute` still returns `status`, `failureReason`, and `attempts`.

## Acceptance criteria

1. AC-01: A tool-call cap before the last attempt starts a later attempt whose prompt has no prior tool results. Given `maxSourceEditIterations` 2, a worktree file `note.txt` whose contents are `cap-sentinel-bytes`, and a script of 150 `read_file` calls on `note.txt` followed by one complete, with loop-input acceptance criteria that do not contain `cap-sentinel-bytes`. Then `execute` returns status `completed` and attempts 2, the attempt 1 transcript records 150 tool calls and `failureReason` `tool-calls`, and the governor prompt for the complete call contains `Attempt ended at the tool-call cap of 150` and does not contain `### Tool results` or `cap-sentinel-bytes`.
2. AC-02: A tool-call cap on the last attempt fails the task and the cap stays 150. Given `maxSourceEditIterations` 1 and a script of 150 `read_file` calls on `note.txt`. Then `execute` returns status `failed`, `failureReason` `tool-calls`, and attempts 1, the governor is called 150 times, and `MINIMAL_TOOL_CALL_CAP` is 150.
3. AC-03: Quality-gate finding text survives the next source write. Given `maxSourceEditIterations` 2, a completion validator whose first result is `pass` false with summary lines `quality-gate failed` and `[eslint] sonarjs/no-duplicate-string src/a.ts:1 - duplicate (abcd)`, and a script of complete, then `write_file` of `src/note.txt`, then complete. Then the governor prompt after that write still contains `quality-gate failed` and `sonarjs/no-duplicate-string`, and that prompt does not equal `FILE_MODIFIED_FEEDBACK`.
4. AC-04: AUDIT_REQUIRED feedback is still replaced after a successful source write. Given `auditGate` true, `maxSourceEditIterations` 1, and a script of complete, then `write_file` of `src/note.txt`, then complete. Then the governor prompt after that write contains `Previous check reported an issue, and a file has since been modified` and does not contain `candidateDigest`.
5. AC-05: The executor and its spec stay within the navigability budget. Given `execution/minimal-executor.ts` and `execution/minimal-executor.spec.mjs` after the change. Then each file is at most 500 lines and at most 20480 bytes.

## Failure defenses

- A cap on the last attempt returns `tool-calls` and does not start another model call.
- An empty governor script on the attempt after a continued cap throws `GOVERNOR_ROUTES_EXHAUSTED` and the task result is `failed`. It does not report `completed`.
- A wall-time stop and a `maxPromptTokens` stop still fail the task on that attempt when later attempts remain.
- Replacing `quality-gate failed` with `FILE_MODIFIED_FEEDBACK` fails AC-03. Leaving an `AUDIT_REQUIRED` body in the prompt after a successful write fails AC-04.
- A second helper file, or either authored file over 500 lines or 20480 bytes, fails AC-05.

## Verification plan

- `execution/minimal-executor.spec.mjs` cites AC-01, AC-02, AC-03, AC-04, and AC-05. Each citation has an `assert`. AC-05 reads the two authored files and asserts line count and byte length.
- The task command is `pnpm run test:unit`.
- Package done bar after implementation: `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`.

## Unresolved questions

_None_

## Assumptions

- The continuation feedback sentence is exactly `Attempt ended at the tool-call cap of 150. Continue the task. Earlier tool results from this task are not in this prompt.`
- `FILE_MODIFIED_FEEDBACK` in `execution/last-summary.ts` stays the sentence that begins `Previous check reported an issue, and a file has since been modified`.
- The fake governor stores each request prompt on `governor.calls` and throws `GOVERNOR_ROUTES_EXHAUSTED` when its script is empty.
- No ADR is offered. The attempt budget and the cap number stay as they are.
