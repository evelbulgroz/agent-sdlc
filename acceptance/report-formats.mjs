import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// Closed, runner-neutral report parsers and the command-evidence pass predicate. Nothing here names a runner.
export const MAX_REPORT_BYTES = 1048576;
const MAX_TEXT = 4096;
const OUTCOMES = ['passed', 'failed', 'error', 'skipped', 'todo'];
const CASE_TAG = /(?:^|\s)@case (AC-\d+\.\d+)(?=\s|$)/;

export class EvidenceReportError extends Error {
	constructor(code, detail) {
		super(`EvidenceReportError: ${code}${detail ? `: ${detail}` : ''}`);
		this.code = code;
	}
}
const reject = (code, detail) => { throw new EvidenceReportError(code, detail); };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body) => {
		if (body.startsWith('#')) {
			const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reject('REPORT_MALFORMED', 'character reference');
		}
		return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : reject('REPORT_MALFORMED', `entity ${body}`);
	});
}

// Minimal strict XML tokenizer: elements, attributes, text, CDATA and comments. DOCTYPE and processing
// instructions other than the declaration are rejected.
function parseXml(source) {
	let index = 0;
	const stack = [];
	let root;
	const attach = (node) => {
		if (stack.length) stack.at(-1).children.push(node);
		else if (root) reject('REPORT_MALFORMED', 'multiple roots');
		else root = node;
	};
	const text = source.replace(/^\uFEFF/, '');
	while (index < text.length) {
		const open = text.indexOf('<', index);
		const chunk = text.slice(index, open === -1 ? text.length : open);
		if (stack.length) stack.at(-1).text += decode(chunk);
		else if (chunk.trim()) reject('REPORT_MALFORMED', 'text outside root');
		if (open === -1) break;
		index = open;
		if (text.startsWith('<!--', index)) {
			const end = text.indexOf('-->', index + 4);
			if (end === -1) reject('REPORT_MALFORMED', 'comment');
			index = end + 3;
		} else if (text.startsWith('<![CDATA[', index)) {
			const end = text.indexOf(']]>', index);
			if (end === -1 || !stack.length) reject('REPORT_MALFORMED', 'cdata');
			stack.at(-1).text += text.slice(index + 9, end);
			index = end + 3;
		} else if (text.startsWith('<?xml', index)) {
			const end = text.indexOf('?>', index);
			if (end === -1 || index !== 0) reject('REPORT_MALFORMED', 'declaration');
			index = end + 2;
		} else if (text.startsWith('<!', index) || text.startsWith('<?', index)) {
			reject('REPORT_UNKNOWN_ELEMENT', 'doctype or processing instruction');
		} else if (text.startsWith('</', index)) {
			const end = text.indexOf('>', index);
			const name = end === -1 ? '' : text.slice(index + 2, end).trim();
			if (!stack.length || stack.at(-1).name !== name) reject('REPORT_MALFORMED', `closing ${name}`);
			stack.pop();
			index = end + 1;
		} else {
			const match = /^<([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(text.slice(index));
			if (!match) reject('REPORT_MALFORMED', 'element syntax');
			const attrs = {};
			for (const pair of match[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
				if (Object.hasOwn(attrs, pair[1])) reject('REPORT_MALFORMED', `duplicate attribute ${pair[1]}`);
				attrs[pair[1]] = decode(pair[2] ?? pair[3]);
			}
			const node = { name: match[1], attrs, children: [], text: '' };
			attach(node);
			if (!match[3]) stack.push(node);
			index += match[0].length;
		}
	}
	if (stack.length || !root) reject('REPORT_MALFORMED', 'unclosed element');
	return root;
}

const SUITE_CHILDREN = new Set(['testsuite', 'testcase', 'properties', 'system-out', 'system-err']);
const CASE_CHILDREN = new Set(['failure', 'error', 'skipped', 'properties', 'system-out', 'system-err']);
const clip = (value) => String(value ?? '').slice(0, MAX_TEXT);

function junitRow(node) {
	const name = node.attrs.name;
	if (!name) reject('REPORT_MALFORMED', 'testcase without name');
	let outcome = 'passed';
	let message = '';
	for (const child of node.children) {
		if (!CASE_CHILDREN.has(child.name)) reject('REPORT_UNKNOWN_ELEMENT', child.name);
		if (child.name === 'properties' && child.children.some((item) => item.name !== 'property')) {
			reject('REPORT_UNKNOWN_ELEMENT', 'properties child');
		}
		const rank = { failure: 'failed', error: 'error', skipped: 'skipped' }[child.name];
		if (!rank) continue;
		if (outcome === 'passed' || rank === 'error' || (rank === 'failed' && outcome === 'skipped')) {
			outcome = rank;
			message = clip(child.attrs.message || child.text.trim());
		}
	}
	return {
		name, outcome, message, ...(node.attrs.classname ? { classname: node.attrs.classname } : {}),
		...(node.attrs.file ? { file: node.attrs.file } : {}),
	};
}

function walk(node, rows) {
	for (const child of node.children) {
		if (child.name === 'testcase') rows.push(junitRow(child));
		else if (child.name === 'testsuite') walk(child, rows);
		else if (!SUITE_CHILDREN.has(child.name)) reject('REPORT_UNKNOWN_ELEMENT', child.name);
		else if (child.name === 'properties' && child.children.some((item) => item.name !== 'property')) {
			reject('REPORT_UNKNOWN_ELEMENT', 'properties child');
		}
	}
}

/** Parses the closed JUnit subset into case rows. Any element outside the subset is rejected. */
export function parseJunit(source) {
	const root = parseXml(source);
	if (root.name !== 'testsuites' && root.name !== 'testsuite') reject('REPORT_UNKNOWN_ELEMENT', root.name);
	const rows = [];
	walk(root, rows);
	return rows;
}

const CaseReportSchema = z.strictObject({
	schemaVersion: z.literal('1.0.0'),
	cases: z.array(z.strictObject({
		name: z.string().min(1), classname: z.string().min(1).optional(), file: z.string().min(1).optional(),
		outcome: z.enum(OUTCOMES), message: z.string().max(MAX_TEXT).optional(), durationMs: z.number().nonnegative().optional(),
	})),
});

/** Parses the engine-defined `case-report` JSON used by wrappers for runners that cannot emit JUnit. */
export function parseCaseReport(source) {
	let value;
	try { value = JSON.parse(source); } catch { return reject('REPORT_MALFORMED', 'json'); }
	const parsed = CaseReportSchema.safeParse(value);
	if (!parsed.success) reject('REPORT_UNKNOWN_ELEMENT', parsed.error.issues[0]?.path.join('.') || 'case-report');
	return parsed.data.cases.map((entry) => ({
		name: entry.name, outcome: entry.outcome === 'todo' ? 'skipped' : entry.outcome, message: clip(entry.message),
		...(entry.classname ? { classname: entry.classname } : {}), ...(entry.file ? { file: entry.file } : {}),
	}));
}

export const parseReport = (format, source) => format === 'junit' ? parseJunit(source)
	: format === 'case-report' ? parseCaseReport(source) : reject('REPORT_MALFORMED', `unknown format ${format}`);

export const identityOf = (name) => CASE_TAG.exec(name)?.[1] ?? name;

/** Groups rows by identity; with `retries` n up to n+1 rows are attempts (last wins), more rows fail closed. */
export function collapseAttempts(rows, retries = 0) {
	const groups = new Map();
	for (const row of rows) {
		const identity = identityOf(row.name);
		groups.set(identity, [...(groups.get(identity) ?? []), row]);
	}
	return [...groups].map(([identity, attempts]) => {
		if (attempts.length > retries + 1) reject('REPORT_DUPLICATE_IDENTITY', identity);
		return { identity, ...attempts.at(-1), attempts: attempts.length };
	});
}

/**
 * Structural checks plus per-case outcomes. `selected` lists corpus case identities (`AC-nn.m`). Throws on
 * zero cases, duplicate identities and an exit code that contradicts the unfiltered report; a selected case
 * that is absent is `not-run`, and any other non-passing row keeps its outcome.
 */
export function selectCases({ rows, selected, exitCode, retries = 0 }) {
	const collapsed = collapseAttempts(rows, retries);
	if (!selected.length || !collapsed.length) reject('REPORT_ZERO_CASES');
	const failing = collapsed.some((row) => row.outcome === 'failed' || row.outcome === 'error');
	if ((exitCode === 0) === failing) reject('REPORT_EXIT_CONTRADICTION', `exit ${exitCode}, failing rows ${failing}`);
	const byIdentity = new Map(collapsed.map((row) => [row.identity, row]));
	return selected.map((identity) => {
		const row = byIdentity.get(identity);
		if (!row) return { identity, outcome: 'not-run', message: '', attempts: 0 };
		return { identity, outcome: row.outcome === 'error' ? 'failed' : row.outcome, message: row.message, attempts: row.attempts };
	});
}

/** The single pass predicate: every selected case present once and passed, else a typed error. */
export function evaluateReport(input) {
	return selectCases(input).map((result) => {
		if (result.outcome === 'not-run') reject('REPORT_CASE_MISSING', result.identity);
		if (result.outcome !== 'passed') {
			reject('REPORT_CASE_NOT_PASSED', `${result.identity} ${result.outcome}${result.message ? `: ${result.message}` : ''}`);
		}
		return result;
	});
}

/** Empties the report directory so any file found afterwards was created by the command. */
export function prepareReportDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });
	for (const entry of fs.readdirSync(directory)) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
}

/** Reads a report as a regular, non-symlinked, size-capped file created at or after `runStartedMs`. */
export function readReportFile(directory, name, { maxBytes = MAX_REPORT_BYTES, runStartedMs } = {}) {
	const file = path.join(directory, name);
	let link;
	try { link = fs.lstatSync(file); } catch { return reject('REPORT_MISSING', name); }
	if (link.isSymbolicLink() || !link.isFile()) reject('REPORT_NOT_REGULAR', name);
	const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) reject('REPORT_NOT_REGULAR', name);
		if (stat.size > maxBytes) reject('REPORT_OVERSIZED', name);
		if (runStartedMs !== undefined && stat.mtimeMs < runStartedMs) reject('REPORT_STALE', name);
		return fs.readFileSync(descriptor, 'utf8');
	} finally {
		fs.closeSync(descriptor);
	}
}
