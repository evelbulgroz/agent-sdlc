import { EvidenceReportError, collapseAttempts, parseJunit, parseReport, selectCases } from './report-formats.mjs';

const suite = (body) => `<testsuites>${body}</testsuites>`;
const pass = (name) => `<testcase name="${name}"/>`;
const rows = (...entries) => entries.map(([name, outcome]) => ({ name, outcome, message: '' }));

// Engine-owned fixtures: every accept case must pass and every reject case must fail closed with its code.
const ACCEPT = [
  ['top-level testcase', () => parseJunit(suite(pass('@case AC-01.1 a'))).length === 1],
  ['nested testsuite', () => parseJunit(suite(`<testsuite><testsuite>${pass('@case AC-01.1 a')}</testsuite></testsuite>`)).length === 1],
  ['collapsed retry', () => selectCases({ rows: rows(['@case AC-01.1 a', 'failed'], ['@case AC-01.1 a', 'passed']),
    selected: ['AC-01.1'], exitCode: 0, retries: 1 })[0].outcome === 'passed'],
  ['unselected failure keeps a non-zero exit honest', () => selectCases({ rows: rows(['@case AC-01.1 a', 'passed'], ['x', 'failed']),
    selected: ['AC-01.1'], exitCode: 1 })[0].outcome === 'passed'],
];
const REJECT = [
  ['unknown element', 'REPORT_UNKNOWN_ELEMENT', () => parseJunit(suite('<testcase name="a"><flaky/></testcase>'))],
  ['malformed xml', 'REPORT_MALFORMED', () => parseJunit('<testsuites><testsuite></testsuites>')],
  ['unknown format', 'REPORT_MALFORMED', () => parseReport('tap', '')],
  ['duplicate identity', 'REPORT_DUPLICATE_IDENTITY', () => collapseAttempts(rows(['@case AC-01.1 a', 'passed'], ['@case AC-01.1 b', 'passed']))],
  ['zero cases', 'REPORT_ZERO_CASES', () => selectCases({ rows: [], selected: ['AC-01.1'], exitCode: 0 })],
  ['exit contradiction', 'REPORT_EXIT_CONTRADICTION', () => selectCases({ rows: rows(['@case AC-01.1 a', 'passed']),
    selected: ['AC-01.1'], exitCode: 1 })],
];

/**
 * Admission-time tripwire: the host's sentinel command must exit non-zero with exactly its planted case failed,
 * which catches an always-green reporter. It never runs in the live suite.
 */
export function checkSentinel({ rows: sentinelRows, exitCode, planted }) {
  const failed = collapseAttempts(sentinelRows).filter((row) => row.outcome === 'failed' || row.outcome === 'error');
  if (exitCode === 0 || failed.length !== 1 || failed[0].identity !== planted) {
    throw new EvidenceReportError('SENTINEL_MISMATCH', `exit ${exitCode}, failed ${failed.map((row) => row.identity).join(',') || 'none'}`);
  }
}

/** Offline, provider-free receipt for the `command` kind. `sentinel` is required when the host declares one. */
export function commandQualificationReceipt({ registrations, sentinelDeclared = false, sentinel } = {}) {
  const failures = [];
  for (const [name, check] of ACCEPT) {
    try { if (!check()) failures.push(`accept fixture failed: ${name}`); } catch { failures.push(`accept fixture threw: ${name}`); }
  }
  for (const [name, code, run] of REJECT) {
    try { run(); failures.push(`reject fixture accepted: ${name}`); } catch (error) {
      if (error.code !== code) failures.push(`reject fixture wrong code: ${name}`);
    }
  }
  if (sentinelDeclared && !sentinel) failures.push('declared sentinel was not run');
  if (sentinel) { try { checkSentinel(sentinel); } catch (error) { failures.push(error.message); } }
  return {
    schemaVersion: '1.0.0', kind: 'command', status: failures.length ? 'blocked' : 'passed', failures,
    liveQualified: false, providerOperations: 0, fixtures: { accept: ACCEPT.length, reject: REJECT.length },
    sentinel: sentinel ? { planted: sentinel.planted } : null,
    commands: (registrations ?? []).map((registration) => ({ adapterId: registration.adapterId, commandSha256: registration.commandSha256 })),
  };
}
