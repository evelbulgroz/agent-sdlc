import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	evaluateReport, parseCaseReport, parseJunit, prepareReportDirectory, readReportFile,
} from './report-formats.mjs';

const suite = (body) => `<?xml version="1.0"?>\n<testsuites>${body}</testsuites>`;
const ok = (name) => `<testcase name="${name}" time="0.1"/>`;
const throwsCode = (fn, code) => assert.throws(fn, (error) => error.code === code, code);
const outcomes = (rows) => rows.map((row) => row.outcome);

test('parses node:test shapes: top-level testcase and nested testsuite', () => {
	const rows = parseJunit(suite(`${ok('@case AC-01.1 a')}<testsuite name="s"><testsuite name="n">${ok('@case AC-01.2 b')}</testsuite></testsuite>`));
	assert.deepEqual(rows.map((row) => row.name), ['@case AC-01.1 a', '@case AC-01.2 b']);
	assert.deepEqual(outcomes(rows), ['passed', 'passed']);
});

test('maps failure, error and skipped children and decodes entities', () => {
	const rows = parseJunit(suite('<testcase name="a &amp; b"><failure message="bad &lt;x&gt;"/></testcase><testcase name="c"><error>boom</error></testcase><testcase name="d"><skipped/></testcase>'));
	assert.deepEqual(outcomes(rows), ['failed', 'error', 'skipped']);
	assert.equal(rows[0].name, 'a & b');
	assert.equal(rows[0].message, 'bad <x>');
});

test('rejects unknown elements, doctype and malformed xml', () => {
	throwsCode(() => parseJunit(suite('<testcase name="a"><flaky/></testcase>')), 'REPORT_UNKNOWN_ELEMENT');
	throwsCode(() => parseJunit(suite('<widget/>')), 'REPORT_UNKNOWN_ELEMENT');
	throwsCode(() => parseJunit('<!DOCTYPE x><testsuites/>'), 'REPORT_UNKNOWN_ELEMENT');
	throwsCode(() => parseJunit('<root/>'), 'REPORT_UNKNOWN_ELEMENT');
	throwsCode(() => parseJunit('<testsuites><testsuite></testsuites>'), 'REPORT_MALFORMED');
	throwsCode(() => parseJunit(suite('<testcase/>')), 'REPORT_MALFORMED');
	throwsCode(() => parseJunit(suite('<testcase name="a&bogus;"/>')), 'REPORT_MALFORMED');
});

test('case-report is closed', () => {
	const rows = parseCaseReport(JSON.stringify({ schemaVersion: '1.0.0', cases: [{ name: 'x', outcome: 'todo' }] }));
	assert.deepEqual(outcomes(rows), ['skipped']);
	throwsCode(() => parseCaseReport(JSON.stringify({ schemaVersion: '1.0.0', cases: [], extra: 1 })), 'REPORT_UNKNOWN_ELEMENT');
	throwsCode(() => parseCaseReport('{'), 'REPORT_MALFORMED');
});

const rows = (...entries) => entries.map(([name, outcome]) => ({ name, outcome, message: '' }));

test('pass predicate accepts selected passes and ignores unselected failures only when exit is non-zero', () => {
	const selected = ['AC-01.1'];
	assert.equal(evaluateReport({ rows: rows(['@case AC-01.1 a', 'passed']), selected, exitCode: 0 }).length, 1);
	assert.equal(evaluateReport({ rows: rows(['@case AC-01.1 a', 'passed'], ['other', 'failed']), selected, exitCode: 1 }).length, 1);
});

test('pass predicate fails closed', () => {
	const selected = ['AC-01.1'];
	const pass = ['@case AC-01.1 a', 'passed'];
	throwsCode(() => evaluateReport({ rows: [], selected, exitCode: 0 }), 'REPORT_ZERO_CASES');
	throwsCode(() => evaluateReport({ rows: rows(pass), selected: [], exitCode: 0 }), 'REPORT_ZERO_CASES');
	throwsCode(() => evaluateReport({ rows: rows(['@case AC-01.2 b', 'passed']), selected, exitCode: 0 }), 'REPORT_CASE_MISSING');
	throwsCode(() => evaluateReport({ rows: rows(['@case AC-01.1 a', 'skipped']), selected, exitCode: 0 }), 'REPORT_CASE_NOT_PASSED');
	throwsCode(() => evaluateReport({ rows: rows(pass, pass), selected, exitCode: 0 }), 'REPORT_DUPLICATE_IDENTITY');
	throwsCode(() => evaluateReport({ rows: rows(pass), selected, exitCode: 1 }), 'REPORT_EXIT_CONTRADICTION');
	throwsCode(() => evaluateReport({ rows: rows(pass, ['x', 'failed']), selected, exitCode: 0 }), 'REPORT_EXIT_CONTRADICTION');
});

test('retries collapse to the last attempt up to n+1 rows', () => {
	const selected = ['AC-01.1'];
	const flaky = rows(['@case AC-01.1 a', 'failed'], ['@case AC-01.1 a', 'passed']);
	const [result] = evaluateReport({ rows: flaky, selected, exitCode: 0, retries: 1 });
	assert.equal(result.attempts, 2);
	throwsCode(() => evaluateReport({ rows: [...flaky, ...flaky], selected, exitCode: 0, retries: 1 }), 'REPORT_DUPLICATE_IDENTITY');
});

function withDirectory(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-report-'));
	try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('report files must exist, be regular, small and fresh', () => {
	withDirectory((dir) => {
		throwsCode(() => readReportFile(dir, 'unit.xml'), 'REPORT_MISSING');
		fs.writeFileSync(path.join(dir, 'unit.xml'), '<testsuites/>');
		assert.equal(readReportFile(dir, 'unit.xml'), '<testsuites/>');
		throwsCode(() => readReportFile(dir, 'unit.xml', { maxBytes: 3 }), 'REPORT_OVERSIZED');
		throwsCode(() => readReportFile(dir, 'unit.xml', { runStartedMs: Date.now() + 60000 }), 'REPORT_STALE');
		fs.symlinkSync('/etc/hostname', path.join(dir, 'link.xml'));
		throwsCode(() => readReportFile(dir, 'link.xml'), 'REPORT_NOT_REGULAR');
		prepareReportDirectory(dir);
		assert.deepEqual(fs.readdirSync(dir), []);
	});
});
