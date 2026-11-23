# Intent

Draft only. Do not start this goal until its sibling obligations file exists. The 24,576-byte critic packing ceiling stays.

## Goal

The checkpoint scores the report the task verification command already produced. It does not launch a second full-suite command for the same profile. A duplicate `@case` id that is not in the selected set does not reject a selected case that passed once. A duplicate of a selected id still fails when retries are zero.

`acceptance/report-formats.ts` `selectCases` throws `REPORT_DUPLICATE_IDENTITY` when the same case id appears more times than `retries + 1`. The historic keyboard checkpoint reran the full browser suite. The six selected historic cases passed, and the report was then rejected because unrelated Enter and Space tests both used `@case AC-01.3`. The task command had already written a TAP report of the historic cases.

## Non-goals

- Do not accept two passing rows for one selected case id when retries are zero.
- Do not drop the file identity from `case-file-criterion` selection.
- Do not change the browser profile's capabilities or timeout.
- Do not raise the packing ceiling.
- Do not treat a green checkpoint as merge trust. The host preflight remains the local done bar.

## Owning context

`acceptance/command-evidence.ts` and `acceptance/report-formats.ts` in agent-sdlc.

## Touched surfaces

- acceptance/command-evidence.ts
- acceptance/report-formats.ts
- acceptance/report-formats.spec.mjs
- acceptance/source-case-selection.ts
- execution/minimal-checkpoint-evidence.spec.mjs

## Invariants and constraints

- Selected case identity stays `file` plus `@case` id under `case-file-criterion`.
- Retries remain the registration value. Zero retries still reject two rows of one selected id.
- The checkpoint reads the task command's report file. It does not spawn the profile command again when that report is the registered command's output.
- An unselected duplicate does not change the exit code required of the selected cases.

## Public contract impact

None. Evidence scoring stays inside the engine. No product HTTP or OpenAPI change.

## Acceptance criteria

1. AC-01: the checkpoint uses the task report. Given a task command that wrote a passing report for the selected cases. Then checkpoint evidence reads that report and does not spawn a second profile command. Cases: AC-01.1: the recorded report path is the one scored; AC-01.2: the profile command spawn count is zero during scoring.
2. AC-02: an unselected duplicate is ignored. Given a report with two rows for `@case AC-01.3` and one passing row for selected `@case AC-02.1`, and retries of zero. Then `selectCases` returns the selected case as passed. Cases: AC-02.1: the unselected pair does not throw; AC-02.2: the selected case outcome is `passed`.
3. AC-03: a selected duplicate still fails. Given two rows for selected `@case AC-02.1` and retries of zero. Then scoring throws `REPORT_DUPLICATE_IDENTITY`. Cases: AC-03.1: the selected id is the duplicate; AC-03.2: retries of one still allow the second attempt of that same id.

## Failure defenses

- A missing task report is `invalid-evidence`, not a second suite run.
- A selected case with no row stays not-run.
- A passing selected case in a report whose process exit is non-zero stays governed by the existing exit rule.

## Verification plan

- `acceptance/report-formats.spec.mjs` proves AC-02 and AC-03.
- `execution/minimal-checkpoint-evidence.spec.mjs` proves AC-01.
- Engine check: `pnpm test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The keyboard-10 full-suite JUnit is the motivating report. Selected historic cases had already passed in that report.
- `acceptance/` is a repository scope in `.agents/sdlc-host.json`, alongside `cli/`, `execution/`, and `review/`.
