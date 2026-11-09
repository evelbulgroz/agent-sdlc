Status: draft, not approved. Queued after the retired `engine-host-cleanup.md` (its S1 turns the size gate on and splits `testing/test-support.mjs`; do that first so new specs land in compliant files, then this spec's S0). Findings come from two independent reviews, checked against engine `main` on 2026-11-09. Verify each claim before implementing.

## Goal

Close the remaining gaps in the deterministic `@ac` coverage gate without moving semantic judgment into it. The gate answers "does every approved id have its own asserting test whose title passed?". Whether an assertion matches Given/Then stays with the QA critic.

## Findings

Confirmed in code:

1. **Substring match.** `execution/ac-coverage.ts:393` uses `passedTitle.includes(eachCaseId)`, so `AC-01.10` discharges `AC-01.1` for `it.each` rows.
2. **Title-only identity.** `bindAcCoverageToExecution` builds one flat set of passed titles. The binder never pairs a title with its file, so a passed test with the same title elsewhere discharges the citation.
3. **Text-only assertion check.** `ASSERTION_RE` (`execution/ac-citations.ts:10`) accepts any `expect(`, `assert(` or `assert.` in the callback text, including comments and `expect(true)`.
4. **Legacy hole.** `workflow/preflight-gate.ts:180-184`: when `newPolicy` is false, an uncovered criterion records `AC_COVERAGE_PASSED` with `coveragePass: false` and enters QA.
5. **Asymmetric binding.** The final gate (`applyAcCoverageGate`) re-reads citations statically; it does not bind runner output.

Reported, not yet verified (check before relying on them):

6. **Partly verified.** `execution/task-verification-plan.ts:188-190` returns the repository verification command unchanged when it is exactly `pnpm run test:unit`, before the `--reporter=json` or `--json` flag is appended. On `node --test` hosts (this engine) that still yields TAP, which parses. On a Vitest or Jest host the output is human text and fails as `UNSUPPORTED_EXECUTION_EVIDENCE`. A non-zero exit returns `verification.output` before `evaluateEvidence` runs (`execution/minimal-executor.ts:308-317`), so `[not-executed]` ids are lost. Confirmed.
7. **Confirmed.** `extractCallbackBody` and `extractBraced` do not strip `//`, `/* */` or regex literals, and `TEST_EACH_CALL_RE` tolerates one level of nested parentheses.
8. **Confirmed.** `execution/minimal-executor.ts:318-326` shares the initial attempt plus two repairs across build preparation, test failures and `evaluateEvidence`.
9. **Corrected.** A baseline test is ignored only when the same file and exact title already exist at `baseCommitSha`, so adding `@ac` to an existing test's title does count. A real bug sits next to it: the baseline set is built from `file + title` (`execution/ac-coverage.ts:165-168`) but the check for `it.each` rows looks up `file + title + eachCaseId` and skips the plain key when `eachCaseId` is set (`:233-239`). Baseline `it.each` citations are therefore never filtered.

## Slices

Each slice is its own commit with user approval and the full engine done bar. Replay baselines are reviewed per slice, never blanket-updated.

### S0. Make room in `execution/minimal-executor.ts`
The file is 498 lines and 20,455 bytes, so S3 cannot fit in it. Split a coherent unit out first (for example the verification-result handling into `minimal-verification.ts`, which is 333 lines). No behaviour change; same test count. Gate: unit tests and replay unchanged. Depends on `engine-host-cleanup.md` S1, which turns the size gate on.

### S1. Exact case-id matching and baseline `it.each` filtering
Replace the substring test with an exact, boundary-aware match (`AC-01.1` must not match `AC-01.10`), and add the `eachCaseId` to the baseline key so baseline `it.each` citations are filtered. Add boundary cases for both directions and for a baseline `it.each` row. Smallest slice; ship first.

### S2. File-scoped execution evidence
Key passed-title evidence by file plus full title where the reporter provides the file. Jest and Vitest JSON report absolute paths inside the worktree while citation rows hold worktree-relative POSIX paths, so pass the worktree directory to the parser and normalize before comparing. `node --test` TAP does not emit a file for passing tests, so it keeps title-only matching and the report says so. Do not name a runner in `ac-coverage.ts` or `test-execution-evidence.ts` outside what `host-neutrality.spec.mjs` already allows. Cases: same title in two files; the cited file's copy fails; absolute versus relative path.

### S3. Static pre-check before the verification command
In the minimal executor, whenever a completion validator is configured for the task, run the static coverage check before the build and test command. The executor has no quality-policy input, so this applies to legacy runs too; record that in `execution/README.md`. A static failure consumes a normal attempt, like `checkMissingAuthoredFiles`. Not consuming one would loop to the 150-call cap inside a single attempt, which breaks the two-repair budget. Requires S0.

### S4. Execution evidence at the final gate
Decided: use the quality store (option a). Under the checkpoint policy each `EvidenceObligation` (`policy/contracts/quality-evidence-schema.ts:63`) names one `criterionId` and a nullable `caseId`, plus the `testCases` it binds. `executeCheckpointObligations` runs the frozen command evidence and stores an `EvidenceReceipt` whose `dischargedObligationIds` lists what passed; it throws `TASK_EXECUTION_FAILED` on any non-passed receipt. So per-criterion, per-case pass evidence already exists at the final gate, and the final gate does not need runner output. The successful verify path returns no runner output (result-file JSON only), and a composite `verify.argv` emits no JSON or TAP, so binding preflight stdout is rejected.

Add a check in `applyAcCoverageGate`, under the checkpoint policy only: every approved criterion id and case id must have an obligation whose id is in the passed receipts' `dischargedObligationIds` for the current candidate binding. Report three distinct failures: `NO_OBLIGATION` (approved id with no obligation), `OBLIGATION_NOT_DISCHARGED`, and `NO_EXECUTION_EVIDENCE` (no receipt for the candidate). Legacy runs have no receipts and keep the static check plus S5. First step: confirm the plan validator already rejects an approved id with no obligation; if it does, `NO_OBLIGATION` is a defensive check only.

### S5. Legacy path
Recommended: (a) route a legacy run's coverage miss to `AC_COVERAGE_FAILED` and a repair. Option (b), dropping `AC_COVERAGE_PASSED` when coverage failed, is rejected: `cli/status-result.ts` reads only `AC_COVERAGE_PASSED`, so the miss would vanish from status while the run still enters QA. (a) changes legacy run outcomes and needs operator approval before implementation.

### S6. No-op assertions
Add a companion check, separate from `ASSERTION_RE`, that flags a test whose only assertions are no-ops (`expect(true)`, a lone `toBeDefined()`). Start as a reported warning. Promote to an error only after the reliability corpus shows no false positives.

## Acceptance criteria

- **AC-01.** `AC-01.10` evidence never discharges `AC-01.1`, in either direction.
- **AC-02.** With a reporter that supplies file paths, a passed title in a different file does not discharge a citation, and absolute reporter paths match worktree-relative citation paths. With `node --test` TAP, matching stays title-only and the report records it.
- **AC-03.** Whenever a completion validator is configured, a static coverage miss does not start the build and test command and consumes one normal attempt.
- **AC-04.** With a checkpoint policy, the final gate fails when any approved criterion or case id has no obligation, or its obligation is not in the passed receipts' `dischargedObligationIds` for the current binding, and reports `NO_OBLIGATION`, `OBLIGATION_NOT_DISCHARGED` or `NO_EXECUTION_EVIDENCE` distinctly. A green composite preflight with fully discharged obligations does not fail.
- **AC-05.** The gate stays model-free: no change adds a model call, and replay stays token-free and deterministic.
- **AC-06.** No existing assertion is weakened, and corpus expectation changes are listed per slice with a reason.
- **AC-07.** Every new or split file is at most 500 lines and 20,480 bytes, and `execution/minimal-executor.ts` is split before S3.
- **AC-08.** In a legacy run, an uncovered criterion no longer records `AC_COVERAGE_PASSED` and enters QA; it records `AC_COVERAGE_FAILED` (S5 option a), and status shows the miss.
- **AC-09.** A baseline `it.each` citation at `baseCommitSha` does not discharge a criterion.

## Open questions

- Are any live runs still without the checkpoint policy? (S5 option (a) was approved by the operator on 2026-11-09.)
- Does a Vitest or Jest host's full-suite command (`pnpm run test:unit`) get a reporter flag injected, or a documented reporter requirement (finding 6)?

## Risks

- S2 and S4 can turn previously green runs red where evidence is weaker than assumed. Mitigation: report "no evidence" distinctly and replay the corpus first.
- S5 changes legacy run outcomes. Mitigation: operator approval and a note in `workflow/README.md` and `execution/README.md`.
- S6 can reject legitimate smoke assertions. Mitigation: warning-only until the corpus is clean.
