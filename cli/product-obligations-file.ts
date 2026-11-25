import fs from 'node:fs';
import path from 'node:path';
import { hasHostProfile, loadHostProfile } from '../host/host-profile.ts';
import { normalizeText } from '../policy/contracts/primitives.ts';
import type { ProductEvidenceConfig } from '../host/product-evidence-schema.ts';
import { liveRunRoot } from '../persistence/run-paths.ts';
import { deriveScopeFromDraft, type DraftScopeInput, type TaskManifestScopeInput } from '../policy/authorization.ts';
import type { TaskManifest } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	acceptProductObligations,
	type ProductObligationManifest,
	type ProductObligationsDocument,
	type ProductQualityCode,
} from '../policy/product-quality-plan.ts';
import { occupiedObligationCases, type OccupiedCaseFinding } from './obligation-case-occupancy.ts';

export const PRODUCT_OBLIGATIONS_FILENAME = 'product-obligations.json';
const MAX_OBLIGATIONS_BYTES = 65_536;

export function productObligationsPath(rootDir: string, runId: string): string {
	return path.join(liveRunRoot(rootDir), runId, PRODUCT_OBLIGATIONS_FILENAME);
}

export function readProductObligationsFile(filename: string): unknown {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filename);
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', `Cannot read product obligations file: ${filename}`, {}, { cause: error });
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > MAX_OBLIGATIONS_BYTES) {
		throw new SdlcError('INVALID_INPUT', `Product obligations file is empty, not a regular file, or too large: ${filename}`);
	}
	try {
		return JSON.parse(fs.readFileSync(filename, 'utf8')) as unknown;
	} catch (error: unknown) {
		throw new SdlcError('INVALID_INPUT', `Product obligations file is not valid JSON: ${filename}`, {}, { cause: error });
	}
}

export function writeProductObligations(rootDir: string, runId: string, document: ProductObligationsDocument): void {
	const target = productObligationsPath(rootDir, runId);
	fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function readStoredProductObligations(rootDir: string, runId: string): unknown | null {
	const target = productObligationsPath(rootDir, runId);
	if (!fs.existsSync(target)) return null;
	return readProductObligationsFile(target);
}

interface DraftFields extends DraftScopeInput {
	goal?: string;
	acceptanceCriteria?: readonly string[];
	touchedSurfaces?: readonly string[];
}

/** Scope-only artifacts have path prefixes and no task ids. Ownership then uses readiness. */
function obligationManifest(
	value: TaskManifest | TaskManifestScopeInput | null,
): ProductObligationManifest | null {
	if (!value || !('schemaVersion' in value)) return null;
	return value;
}

function declaredExemptSpecs(rootDir: string): string[] {
	if (!hasHostProfile(rootDir)) return [];
	const profile = loadHostProfile(rootDir);
	return [profile.qualificationFixture?.spec, profile.acceptanceEvidence?.canary?.spec]
		.filter((spec): spec is string => typeof spec === 'string' && spec.length > 0);
}

function relativeGoal(rootDir: string, goalFile: string): string | null {
	const root = path.resolve(rootDir);
	const rel = path.relative(root, path.resolve(root, goalFile));
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	const posix = rel.split(path.sep).join('/');
	return posix.length > 0 ? posix : null;
}

/** Standing qualification and acceptance-canary specs keep their own evidence and skip product obligations. */
function goalFileIsExempt(rootDir: string, goalFile: string | null): boolean {
	if (!goalFile) return false;
	const rel = relativeGoal(rootDir, goalFile);
	return rel !== null && declaredExemptSpecs(rootDir).includes(rel);
}

function goalTextIsExempt(rootDir: string, goalText: string | null | undefined): boolean {
	if (!goalText) return false;
	for (const spec of declaredExemptSpecs(rootDir)) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(path.resolve(rootDir), spec), 'utf8');
		} catch {
			continue;
		}
		if (normalizeText(text) === goalText) return true;
	}
	return false;
}

function hostProduct(rootDir: string): { repositoryId: string; productEvidence: ProductEvidenceConfig | null } | null {
	if (!hasHostProfile(rootDir)) return null;
	const profile = loadHostProfile(rootDir);
	return { repositoryId: profile.repositoryId, productEvidence: profile.productEvidence ?? null };
}

function acceptForHost({
	rootDir, draft, taskManifest, obligations, code,
}: {
	rootDir: string;
	draft: DraftFields;
	taskManifest: TaskManifest | TaskManifestScopeInput | null;
	obligations: unknown | null;
	code: ProductQualityCode;
}) {
	const host = hostProduct(rootDir);
	const productEvidence = host?.productEvidence ?? null;
	if (!productEvidence && obligations === null) return null;
	const scope = deriveScopeFromDraft(draft, taskManifest, { rootDir });
	return acceptProductObligations({
		rootDir,
		repositoryId: host?.repositoryId ?? '',
		productEvidence,
		criteria: draft.acceptanceCriteria ?? [],
		obligations,
		taskManifest: obligationManifest(taskManifest),
		draft: {
			goal: draft.goal ?? '',
			acceptanceCriteria: draft.acceptanceCriteria ?? [],
			touchedSurfaces: draft.touchedSurfaces ?? [],
		},
		allowedPathPrefixes: scope.allowedPathPrefixes,
		code,
	});
}

export interface StartObligationsLoad {
	document: ProductObligationsDocument | null;
	occupiedCases: OccupiedCaseFinding[];
}

/**
 * Validates a start-time obligations file. Occupancy is draft admission only:
 * a later quality-plan rebuild must not reject case ids the implementer added.
 */
export function loadStartObligations({
	rootDir, draft, taskManifest, obligationsFile, goalFile = null,
}: {
	rootDir: string;
	draft: DraftFields;
	taskManifest: TaskManifest | null;
	obligationsFile: string | null;
	goalFile?: string | null;
}): StartObligationsLoad {
	if (!obligationsFile && goalFileIsExempt(rootDir, goalFile)) return { document: null, occupiedCases: [] };
	const obligations = obligationsFile ? readProductObligationsFile(path.resolve(rootDir, obligationsFile)) : null;
	const document = acceptForHost({ rootDir, draft, taskManifest, obligations, code: 'INVALID_INPUT' })?.document ?? null;
	return { document, occupiedCases: document ? occupiedObligationCases(rootDir, document) : [] };
}

/** Validates a start-time obligations file and returns the document to store with the run. */
export function prepareStartObligations(input: {
	rootDir: string;
	draft: DraftFields;
	taskManifest: TaskManifest | null;
	obligationsFile: string | null;
	goalFile?: string | null;
}): ProductObligationsDocument | null {
	const loaded = loadStartObligations(input);
	if (loaded.occupiedCases.length > 0) {
		throw new SdlcError('INVALID_INPUT', loaded.occupiedCases.map((item) => item.remedy).join('\n'));
	}
	return loaded.document;
}

/** Rebuilds the checkpoint quality plan from the obligations stored with the run. */
export function qualityPlanForStoredObligations({
	rootDir, runId, draft, taskManifest, goalText = null,
}: {
	rootDir: string;
	runId: string;
	draft: DraftFields;
	taskManifest: TaskManifest | TaskManifestScopeInput | null;
	goalText?: string | null;
}) {
	const obligations = readStoredProductObligations(rootDir, runId);
	if (obligations === null && goalTextIsExempt(rootDir, goalText)) return undefined;
	return acceptForHost({
		rootDir, draft, taskManifest, obligations, code: 'AUTHORIZATION_INVALID',
	})?.plan;
}
