import assert from 'node:assert/strict';
import test from 'node:test';
import { excerptObligatedCases } from './obligation-case-excerpt.ts';

test('an obligated each title is excerpted and a commented call is not', () => {
	const source = [
		'// test("month @case AC-01.1", () => { assert.equal(1, 1); });',
		'test.each([1])("month @case AC-01.1", () => { assert.equal(1, 1); });',
	].join('\n');
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source,
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, []);
	assert.match(excerpt.text, /@case AC-01\.1/);
	assert.equal(excerpt.text.includes('// test'), false);
});

test('a constant interpolation is excerpted as its rendered title', () => {
	const source = [
		'const sample = "test(\\"month @case AC-01.1\\", () => { assert.equal(1, 1); })";',
		'test(`say "hi" @case ${"AC-01.1"}`, () => { assert.equal(1, 1); });',
	].join('\n');
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source,
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, []);
	assert.equal(excerpt.text.match(/@case AC-01\.1/g)?.length, 1);
	assert.match(excerpt.text, /assert\.equal/);
	assert.equal(excerpt.text.includes('${'), false);
});

test('an unresolved tagged title has no excerpt', () => {
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: 'const tag = "@case AC-01.1";\ntest(`month ${tag}`, () => { assert.equal(1, 1); });\n',
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, ['AC-01.1']);
	assert.equal(excerpt.text, '');
});

test('a continued title is excerpted only when every term is constant', () => {
	const dynamic = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: "test('month @case ' + caseId, () => { assert.equal(1, 1); });\n",
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(dynamic.missingCaseIds, ['AC-01.1']);
	assert.equal(dynamic.text, '');
	const folded = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: "test('month @case ' + 'AC-01.1', () => { assert.equal(1, 1); });\n",
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(folded.missingCaseIds, []);
	assert.match(folded.text, /@case AC-01\.1/);
	assert.match(folded.text, /assert\.equal/);
	assert.equal(folded.text.includes('+'), false);
});

test('a tagged-template each table excerpts the following title', () => {
	const source = [
		'test.each`',
		'  value',
		'  ${1}',
		"`('renders @case AC-01.1', () => { assert.equal(1, 1); });",
		'',
	].join('\n');
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source,
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, []);
	assert.match(excerpt.text, /@case AC-01\.1/);
	assert.match(excerpt.text, /assert\.equal/);
	assert.equal(excerpt.text.includes('value'), false);
	const hidden = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: ['test.each`', '  id', '  ${"AC-01.1"}', "`('month @case $id', () => { assert.equal(1, 1); });", ''].join('\n'),
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(hidden.missingCaseIds, ['AC-01.1']);
	assert.equal(hidden.text, '');
});

test('a concurrent title is excerpted', () => {
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: 'test.concurrent("already @case AC-01.1", () => { assert.equal(1, 1); });\n',
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, []);
	assert.match(excerpt.text, /assert\.equal\(1, 1\)/);
	assert.equal(excerpt.text.includes('no assertion lines'), false);
});

test('braces in comments stay inside the cited callback', () => {
	const following = [
		'test("other @case AC-09.9", () => {',
		'  assert.equal(2, 2);',
		'});',
	];
	for (const comment of [
		'  // {',
		'  // }',
		'  /* { */',
		'  /* } */',
		'  /* {\n     still a comment\n  */',
		'  /* }\n     still a comment\n  */',
	]) {
		const source = [
			'test("already @case AC-01.1", () => {',
			comment,
			'  const note = "// }";',
			'  assert.equal(1, 1);',
			'});',
			...following,
		].join('\n');
		const excerpt = excerptObligatedCases({
			filePath: 'pkg/widget.spec.ts',
			source,
			caseIds: ['AC-01.1'],
			maxBytes: 24_576,
		});
		assert.deepEqual(excerpt.missingCaseIds, [], comment);
		assert.match(excerpt.text, /assert\.equal\(1, 1\)/, comment);
		assert.equal(excerpt.text.includes('AC-09.9'), false, comment);
		assert.equal(excerpt.text.includes('assert.equal(2, 2)'), false, comment);
		assert.equal(excerpt.text.includes('no assertion lines'), false, comment);
	}
});

test('braces in a regex literal stay inside the cited callback', () => {
	const following = [
		'test("other @case AC-09.9", () => {',
		'  assert.equal(2, 2);',
		'});',
	];
	const bodies = [
		'  assert.match("{", /\\{/);',
		'  const pattern = /a{2}/;\n  assert.equal(1, 1);',
		'  const pattern = /\\}/;\n  assert.equal(1, 1);',
		'  const pattern = /[}]/;\n  assert.equal(1, 1);',
		'  const ratio = 1 / 2;\n  const pattern = /a{2}/;\n  assert.equal(1, 1);',
		'  if (false) return /\\{/;\n  assert.equal(1, 1);',
	];
	for (const body of bodies) {
		const source = [
			'test("already @case AC-01.1", () => {',
			body,
			'});',
			...following,
		].join('\n');
		const excerpt = excerptObligatedCases({
			filePath: 'pkg/widget.spec.ts',
			source,
			caseIds: ['AC-01.1'],
			maxBytes: 24_576,
		});
		assert.deepEqual(excerpt.missingCaseIds, [], body);
		assert.match(excerpt.text, /assert\.(?:equal\(1, 1\)|match\()/, body);
		assert.equal(excerpt.text.includes('AC-09.9'), false, body);
		assert.equal(excerpt.text.includes('assert.equal(2, 2)'), false, body);
		assert.equal(excerpt.text.includes('no assertion lines'), false, body);
		if (body.includes('assert.match')) assert.match(excerpt.text, /assert\.match\("\{", \/\\\{\/\)/, body);
	}
});

test('a regex after a control condition stays inside the cited callback', () => {
	const following = [
		'test("other @case AC-09.9", () => {',
		'  assert.equal(2, 2);',
		'});',
	];
	const bodies = [
		'  if (true)\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (/[)]/.test(")")) /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (true) // guard comment\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (true // ) comment noise\n  ) /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (Boolean(`outer ${`inner )`} tail`)) /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if // control comment\n  (true) /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (label === "//")\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (true) /* guard comment */\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  const quota = foo() // keep division\n    / 2;\n  const pattern = /a{2}/;\n  assert.equal(1, 1);',
		'  while (ready)\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  for (const item of [1])\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  for await (const item of [])\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  if (foo("("))\n    /\\{/.test("{");\n  assert.equal(1, 1);',
		'  const quota = foo() / 2;\n  const pattern = /a{2}/;\n  assert.equal(1, 1);',
		'  const quota = (1 + 2) / { value: 2 }.value;\n  assert.equal(1, 1);',
	];
	for (const body of bodies) {
		const source = [
			'test("already @case AC-01.1", () => {',
			body,
			'});',
			...following,
		].join('\n');
		const excerpt = excerptObligatedCases({
			filePath: 'pkg/widget.spec.ts',
			source,
			caseIds: ['AC-01.1'],
			maxBytes: 24_576,
		});
		assert.deepEqual(excerpt.missingCaseIds, [], body);
		assert.match(excerpt.text, /assert\.equal\(1, 1\)/, body);
		assert.equal(excerpt.text.includes('AC-09.9'), false, body);
		assert.equal(excerpt.text.includes('assert.equal(2, 2)'), false, body);
		assert.equal(excerpt.text.includes('it("{")'), false, body);
		assert.equal(excerpt.text.includes('no assertion lines'), false, body);
	}
});

test('an each placeholder title has no excerpt', () => {
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: "test.each(['AC-01.1'])('month @case %s', () => { assert.equal(1, 1); });\n",
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, ['AC-01.1']);
	assert.equal(excerpt.text, '');
});

test('a constant interpolation of a whole case tag is excerpted', () => {
	const excerpt = excerptObligatedCases({
		filePath: 'pkg/widget.spec.ts',
		source: 'test(`month ${"@case AC-01.1"}`, () => { assert.equal(1, 1); });\n',
		caseIds: ['AC-01.1'],
		maxBytes: 24_576,
	});
	assert.deepEqual(excerpt.missingCaseIds, []);
	assert.match(excerpt.text, /@case AC-01\.1/);
	assert.equal(excerpt.text.includes('${'), false);
});
