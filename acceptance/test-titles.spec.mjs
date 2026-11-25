import assert from 'node:assert/strict';
import test from 'node:test';
import { caseIdsInTitle, staticTestTitles } from './test-titles.ts';

function ids(source) {
	return staticTestTitles(source).flatMap((hit) => hit.unresolved ? [`unresolved@${hit.index}`] : caseIdsInTitle(hit.title));
}

test('rendered titles agree with the scorer and literals are not calls', () => {
	const source = [
		'// test("month @case AC-01.1", () => {});',
		'/* test("month @case AC-01.1", () => {}); */',
		'const sample = "test(\\"month @case AC-01.1\\", () => {})";',
		'const tpl = `test("month @case AC-01.1", () => {})`;',
		'const pattern = /test("month @case AC-09.9")/;',
		'return /test("month @case AC-09.9")/;',
		'testing("no @case AC-08.1", () => {});',
		'obj.it("no @case AC-08.1", () => {});',
		'test(`month @case AC-01.1`, () => {});',
		'test.each([1])("row @case AC-02.1", () => {});',
		'it.only.each([1])(\'row @case AC-02.1\', () => {});',
		'it.skip("skip @case AC-07.1", () => {});',
		'test?.("opt @case AC-07.2", () => {});',
		'test(`month @case ${"AC-01.1"}`, () => {});',
		'test(`month @case ${\'AC-03.1\'}`, () => {});',
		'test(`nested @case ${`AC-${"04.1"}`}`, () => {});',
		'test(`paren @case ${("AC-05.1")}`, () => {});',
		'test(`month @case \\u0041C-06.1`, () => {});',
		'test(`month\\n@case AC-06.2`, () => {});',
		'test(`month @case ${id}`, () => {});',
		'test(`month @case AC-${n}`, () => {});',
		'test(`month @ca${rest} AC-01.1`, () => {});',
		'test(`hello ${name}`, () => {});',
		'test(`${id}`, () => {});',
		'const tag = "@case AC-01.1";',
		'test(`month ${tag}`, () => {});',
		'test(tag, () => {});',
		'test(`month @case${"AC-01.1"}`, () => {});',
		'const nested = `pre ${test("inner @case AC-10.1", () => {})}`;',
		'const divided = 1 / test("div @case AC-10.2", () => {});',
	].join('\n');
	const hits = staticTestTitles(source);
	for (const hit of hits) {
		assert.match(source.slice(hit.index, hit.index + 4), /^(?:it|test)/);
		assert.equal(source[hit.index + hit.length - 1], hit.quote);
	}
	const resolved = hits.filter((hit) => !hit.unresolved);
	assert.deepEqual(caseIdsInTitle(resolved.find((hit) => hit.title === 'month @case AC-01.1')?.title ?? ''), ['AC-01.1']);
	assert.equal(resolved.filter((hit) => caseIdsInTitle(hit.title).includes('AC-01.1')).length, 2);
	assert.equal(resolved.filter((hit) => hit.title.includes('AC-02.1')).length, 2);
	assert.equal(resolved.some((hit) => hit.each && hit.title === 'row @case AC-02.1'), true);
	assert.deepEqual(ids('test(`month @case ${\'AC-03.1\'}`, () => {});'), ['AC-03.1']);
	assert.deepEqual(ids('test(`nested @case ${`AC-${"04.1"}`}`, () => {});'), ['AC-04.1']);
	assert.deepEqual(ids('test(`paren @case ${("AC-05.1")}`, () => {});'), ['AC-05.1']);
	assert.deepEqual(ids('test(`month @case \\u0041C-06.1`, () => {});'), ['AC-06.1']);
	assert.deepEqual(ids('test(`month\\n@case AC-06.2`, () => {});'), ['AC-06.2']);
	assert.deepEqual(ids('it.skip("skip @case AC-07.1", () => {});'), ['AC-07.1']);
	assert.deepEqual(ids('test?.("opt @case AC-07.2", () => {});'), ['AC-07.2']);
	assert.deepEqual(ids('const nested = `pre ${test("inner @case AC-10.1", () => {})}`;'), ['AC-10.1']);
	assert.deepEqual(ids('const divided = 1 / test("div @case AC-10.2", () => {});'), ['AC-10.2']);
	assert.deepEqual(ids('test(`month @case${"AC-01.1"}`, () => {});'), []);
	assert.deepEqual(ids('test(`month ${"@case AC-01.1"}`, () => {});'), ['AC-01.1']);
	assert.deepEqual(ids('test(`month @case\\nAC-01.1`, () => {});'), []);
	assert.equal(hits.filter((hit) => hit.unresolved).length, 7);
	assert.equal(hits.some((hit) => hit.title.startsWith('hello')), false);
	for (const sourceText of [
		'test(`${id}`, () => {});',
		'test(`hello ${name}`, () => {});',
		'const tag = "@case AC-01.1";\ntest(`month ${tag}`, () => {});',
		'test(tag, () => {});',
		'test.each([1])(`month ${tag}`, () => {});',
	]) {
		assert.equal(staticTestTitles(sourceText).some((hit) => hit.unresolved), true);
	}
	assert.equal(staticTestTitles('test(() => {});').length, 0);
	assert.equal(staticTestTitles('test(function month() {});').length, 0);
	assert.equal(staticTestTitles('test(name => {});').length, 0);
	assert.deepEqual(ids('test(("month @case AC-11.1"), () => {});'), ['AC-11.1']);
	assert.equal(hits.some((hit) => hit.title.includes('AC-08.1') || hit.title.includes('AC-09.9')), false);
	assert.deepEqual(ids("test('month @case ' + 'AC-12.1', () => {});"), ['AC-12.1']);
	assert.deepEqual(ids('test(`month @case ` + "AC-12.2", () => {});'), ['AC-12.2']);
	assert.deepEqual(ids('test(`month @case ${"AC-" + "12.3"}`, () => {});'), ['AC-12.3']);
	assert.deepEqual(ids('test(("month @case " + "AC-12.4"), () => {});'), ['AC-12.4']);
	assert.deepEqual(ids("test('month @case ' + 'AC-' + '12.5', () => {});"), ['AC-12.5']);
	assert.deepEqual(ids("test('kept %% @case AC-13.1', () => {});"), ['AC-13.1']);
	assert.deepEqual(ids("test('month %s @case AC-01.1', () => {});"), ['AC-01.1']);
	const literalPercent = staticTestTitles("test.each([1])('done %% @case AC-13.1', () => {});");
	assert.equal(literalPercent[0].unresolved, false);
	assert.deepEqual(caseIdsInTitle(literalPercent[0].title), ['AC-13.1']);
	for (const sourceText of [
		"test('month @case ' + caseId, () => {});",
		'test(`month @case AC-01.1` + extra, () => {});',
		"test('month @case '.concat(caseId), () => {});",
		"test('month @case ' + 'AC-01.1' + caseId, () => {});",
		"test.each(['AC-01.1'])('month @case %s', () => {});",
		'test.each([{ id: "AC-01.1" }])("month @case $id", () => {});',
		"test.each([1])('month %s @case AC-02.1', () => {});",
		'test.each([1])(`month @case ${"%s"}`, () => {});',
	]) {
		const found = staticTestTitles(sourceText);
		assert.equal(found.length, 1, sourceText);
		assert.equal(found[0].unresolved, true, sourceText);
		assert.equal(found[0].title, '', sourceText);
		assert.equal(sourceText[found[0].index + found[0].length - 1], found[0].quote, sourceText);
	}
	assert.deepEqual(
		ids("test('month @case ' + test('inner @case AC-10.3', () => {}), () => {});"),
		['unresolved@0', 'AC-10.3'],
	);
	const tagged = [
		'test.each`',
		'  value',
		'  ${1}',
		"`('renders @case AC-14.1', () => {});",
	].join('\n');
	const taggedHits = staticTestTitles(tagged);
	assert.equal(taggedHits.length, 1);
	assert.equal(taggedHits[0].each, true);
	assert.equal(taggedHits[0].unresolved, false);
	assert.deepEqual(caseIdsInTitle(taggedHits[0].title), ['AC-14.1']);
	assert.equal(tagged[taggedHits[0].index + taggedHits[0].length - 1], taggedHits[0].quote);
	assert.deepEqual(ids([
		'test.each`',
		'  ${test("inner @case AC-10.4", () => {})}',
		"`('outer @case AC-14.2', () => {});",
	].join('\n')), ['AC-14.2', 'AC-10.4']);
	assert.deepEqual(ids('test.concurrent("already @case AC-01.1", () => {});'), ['AC-01.1']);
	assert.deepEqual(ids('it.concurrent.only("row @case AC-15.1", () => {});'), ['AC-15.1']);
	assert.deepEqual(ids('test.only.concurrent("row @case AC-15.3", () => {});'), ['AC-15.3']);
	assert.deepEqual(ids('test.concurrent.each([1])("row @case AC-15.2", () => {});'), ['AC-15.2']);
	assert.deepEqual(ids('it.skip.concurrent.each`\n${1}\n`("row @case AC-15.4", () => {});'), ['AC-15.4']);
	assert.equal(staticTestTitles('test.concurrent.each([1])("month @case %s", () => {});')[0].unresolved, true);
	assert.deepEqual(ids('it.only.each`\n${1}\n`("row @case AC-14.3", () => {});'), ['AC-14.3']);
	assert.deepEqual(ids("it.skip.each`\n${1}\n`('row @case AC-14.4', () => {});"), ['AC-14.4']);
	assert.deepEqual(ids([
		'test.each`',
		'  ${1}',
		'` /* table */ (\'row @case AC-14.6\', () => {});',
	].join('\n')), ['AC-14.6']);
	for (const sourceText of [
		['test.each`', '  id', '  ${"AC-01.1"}', "`('month @case $id', () => {});"].join('\n'),
		'test.each`\n${1}\n`("month @case %s", () => {});',
		'test.each`\n  value\n  ${1}\n(\'renders @case AC-14.5\', () => {});\n',
	]) {
		const found = staticTestTitles(sourceText);
		assert.equal(found.length >= 1, true, sourceText);
		assert.equal(found.some((hit) => hit.unresolved), true, sourceText);
		assert.equal(found.some((hit) => caseIdsInTitle(hit.title).includes('AC-14.5')), false, sourceText);
		assert.equal(found.some((hit) => hit.title.includes('$id') || hit.title.includes('%s')), false, sourceText);
	}
});
