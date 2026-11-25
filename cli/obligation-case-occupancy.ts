import fs from 'node:fs';
import path from 'node:path';
import { caseIdsInTitle, staticTestTitles } from '../acceptance/test-titles.ts';
import type { ProductObligationsDocument } from '../policy/product-quality-plan.ts';

const MAX_TEST_FILE_BYTES = 1_048_576;

export interface OccupiedCaseFinding {
	caseId: string;
	testFile: string;
	count: number;
	remedy: string;
}

function occupiedRemedy(caseId: string, testFile: string, count: number): string {
	const times = count === 1 ? 'time' : 'times';
	return `Case id ${caseId} already appears ${count} ${times} in ${testFile}. Choose a case id that does not appear in that file and keep the existing tests.`;
}

function unresolvedRemedy(caseId: string, testFile: string): string {
	return `Test file ${testFile} has a test title whose @case tag cannot be resolved. Write case id ${caseId} as a literal in the test title and keep the existing tests.`;
}

function containedFile(rootDir: string, testFile: string): string | null {
	if (!testFile || testFile.includes('\\') || testFile.includes('\0') || path.isAbsolute(testFile)) return null;
	if (testFile.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) return null;
	const root = path.resolve(rootDir);
	const full = path.resolve(root, testFile);
	const relative = path.relative(root, full);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
	return full;
}

function openNamedTest(
	rootDir: string,
	testFile: string,
): { kind: 'missing' } | { kind: 'reject'; remedy: string } | { kind: 'text'; text: string } {
	const unreadable = `Test file ${testFile} could not be read. Point testFile at the spec the new case will be added to and keep the existing tests.`;
	const irregular = `Test file ${testFile} is not a regular file. Point testFile at the spec the new case will be added to and keep the existing tests.`;
	const oversize = `Test file ${testFile} is too large to check case ids. Point testFile at the spec that will hold the new case and keep the existing tests.`;
	let current = path.resolve(rootDir);
	const segments = testFile.split('/');
	for (const [index, segment] of segments.entries()) {
		current = path.join(current, segment);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error: unknown) {
			const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
			if (code === 'ENOENT') return { kind: 'missing' };
			return { kind: 'reject', remedy: unreadable };
		}
		const last = index === segments.length - 1;
		if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
			return { kind: 'reject', remedy: irregular };
		}
	}
	let descriptor: number;
	try {
		descriptor = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch {
		return { kind: 'reject', remedy: unreadable };
	}
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) return { kind: 'reject', remedy: irregular };
		if (stat.size > MAX_TEST_FILE_BYTES) return { kind: 'reject', remedy: oversize };
		return { kind: 'text', text: fs.readFileSync(descriptor, 'utf8') };
	} catch {
		return { kind: 'reject', remedy: unreadable };
	} finally {
		fs.closeSync(descriptor);
	}
}

function assessCaseId(source: string, caseId: string): { count: number; unresolved: boolean } {
	let count = 0;
	let unresolved = false;
	for (const hit of staticTestTitles(source)) {
		if (hit.unresolved) {
			unresolved = true;
			continue;
		}
		count += caseIdsInTitle(hit.title).filter((id) => id === caseId).length;
	}
	return { count, unresolved };
}

/**
 * Reads only the obligations' named test files. A missing file is free: the
 * implementer creates it. This must not run after those cases have been added.
 */
export function occupiedObligationCases(
	rootDir: string,
	document: ProductObligationsDocument,
): OccupiedCaseFinding[] {
	const rows = new Map<string, { caseId: string; testFile: string }>();
	for (const row of document.obligations) {
		rows.set(`${row.testFile}\0${row.caseId}`, { caseId: row.caseId, testFile: row.testFile });
	}
	const findings: OccupiedCaseFinding[] = [];
	for (const { caseId, testFile } of rows.values()) {
		const full = containedFile(rootDir, testFile);
		if (!full) {
			findings.push({
				caseId, testFile, count: 0,
				remedy: `Test file ${testFile} is outside the repository. Use a repository-relative path and keep the existing tests.`,
			});
			continue;
		}
		const opened = openNamedTest(rootDir, testFile);
		if (opened.kind === 'missing') continue;
		if (opened.kind === 'reject') {
			findings.push({ caseId, testFile, count: 0, remedy: opened.remedy });
			continue;
		}
		const assessed = assessCaseId(opened.text, caseId);
		if (assessed.count > 0) {
			findings.push({
				caseId, testFile, count: assessed.count, remedy: occupiedRemedy(caseId, testFile, assessed.count),
			});
		} else if (assessed.unresolved) {
			findings.push({ caseId, testFile, count: 0, remedy: unresolvedRemedy(caseId, testFile) });
		}
	}
	return findings;
}
