import assert from 'node:assert/strict';
import test from 'node:test';
import { withLastSummary } from './last-summary.ts';

const failed = { done: true, result: { status: 'failed', failureReason: 'evidence-failed', attempts: 3 } };

test('withLastSummary attaches a trimmed, capped summary to a failed result', () => {
	const out = withLastSummary(failed, `  Blocked: which rule wins? ${'x'.repeat(600)}`);
	assert.equal(out.result.failureReason, 'evidence-failed');
	assert.ok(out.result.lastSummary.startsWith('Blocked: which rule wins?'));
	assert.equal(out.result.lastSummary.length, 500);
});

test('withLastSummary leaves completed results, retries and empty or non-string summaries untouched', () => {
	const completed = { done: true, result: { status: 'completed', failureReason: null, attempts: 1 } };
	const retry = { done: false, feedback: 'again' };
	assert.equal(withLastSummary(completed, 'done'), completed);
	assert.equal(withLastSummary(retry, 'blocked'), retry);
	for (const summary of ['', '   ', undefined, 42, null]) assert.equal(withLastSummary(failed, summary), failed);
});
