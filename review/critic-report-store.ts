// Critic review persistence. This module hides the `tools/.review/<runId>` layout:
// the per-generation report file, the run manifest, and the runtime-store record.
// Leaf module; it never imports the adapter or gate.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validateCriticReviewRecord, type CriticReviewRecord } from '../policy/contracts.ts';

export interface CriticReportStoreRuntimeLike {
	saveCriticReview(record: Readonly<CriticReviewRecord>): unknown;
}

export interface PersistCriticReviewInput {
	rootDir: string;
	reviewBaseDir: string;
	runtimeStore?: CriticReportStoreRuntimeLike | null;
	runId: string;
	generation: number;
	phase: string;
	canonicalAuthors: readonly string[];
	reviewerVendor: string;
	reviewerModel: string;
	artifactHash: string;
	attemptKey: string;
	status: 'PASS' | 'FAIL';
	findings: readonly unknown[];
	ungroundedFindings: readonly unknown[];
	coverageMatrix?: unknown;
	hasP1: boolean;
	operationId: string;
	usageRecordIds: readonly string[];
}

export interface PersistedCriticReport {
	schemaVersion: '1.0.0';
	reviewId: string;
	runId: string;
	generation: number;
	phase: string;
	authorVendor: string | undefined;
	authorVendors: readonly string[];
	reviewerVendor: string;
	reviewerModel: string;
	artifactHash: string;
	attemptKey: string;
	status: 'PASS' | 'FAIL';
	findings: readonly unknown[];
	ungroundedFindings: readonly unknown[];
	coverageMatrix: unknown;
	hasP1: boolean;
	operationId: string;
	usageRecordIds: readonly string[];
	reviewedAt: string;
}

export interface PersistCriticReviewResult {
	reviewId: string;
	report: PersistedCriticReport;
	reportPath: string;
	manifestPath: string;
}

interface CriticReviewManifest {
	schemaVersion: string;
	runId: string;
	authorVendor: string | undefined;
	authorVendors: readonly string[];
	reviews: Array<{
		reviewId: string;
		generation: number;
		phase: string;
		reviewerVendor: string;
		reviewerModel: string;
		reportPath: string;
		findingsCount: number;
		ungroundedFindingsCount: number;
		hasP1: boolean;
		operationId: string;
		reviewedAt: string;
	}>;
}

/**
 * Writes `g<generation>-<phase>-report.json` and `manifest.json` under
 * `<reviewBaseDir>/<runId>`, appends to an existing manifest, validates the review
 * record, and saves it to the runtime store when one is present.
 */
export function persistCriticReview({
	rootDir,
	reviewBaseDir,
	runtimeStore,
	runId,
	generation,
	phase,
	canonicalAuthors,
	reviewerVendor,
	reviewerModel,
	artifactHash,
	attemptKey,
	status,
	findings,
	ungroundedFindings,
	coverageMatrix,
	hasP1,
	operationId,
	usageRecordIds,
}: PersistCriticReviewInput): PersistCriticReviewResult {
	const canonicalAuthor = canonicalAuthors[0];
	const reviewedAt = new Date().toISOString();
	const reviewId = `critic-${phase}-${generation}-${crypto.randomUUID().slice(0, 8)}`;

	// Host-side storage under tools/.review/<runId>/
	const runReviewDir = path.join(reviewBaseDir, runId);
	fs.mkdirSync(runReviewDir, { recursive: true, mode: 0o700 });

	const reportFileName = `g${generation}-${phase}-report.json`;
	const reportPath = path.join(runReviewDir, reportFileName);
	const relativeReportPath = path.relative(rootDir, reportPath);

	const report: PersistedCriticReport = {
		schemaVersion: '1.0.0',
		reviewId,
		runId,
		generation,
		phase,
		authorVendor: canonicalAuthor,
		authorVendors: canonicalAuthors,
		reviewerVendor,
		reviewerModel,
		artifactHash,
		attemptKey,
		status,
		findings,
		ungroundedFindings,
		coverageMatrix: coverageMatrix ?? undefined,
		hasP1,
		operationId,
		usageRecordIds,
		reviewedAt,
	};
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

	const manifestPath = path.join(runReviewDir, 'manifest.json');
	const relativeManifestPath = path.relative(rootDir, manifestPath);
	let manifest: CriticReviewManifest = {
		schemaVersion: '1.0.0',
		runId,
		authorVendor: canonicalAuthor,
		authorVendors: canonicalAuthors,
		reviews: [],
	};
	if (fs.existsSync(manifestPath)) {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			if (parsed && typeof parsed === 'object' && 'reviews' in parsed && Array.isArray(parsed.reviews)) {
				manifest = parsed as CriticReviewManifest;
			}
		} catch {
			// use default manifest structure
		}
	}
	manifest.authorVendor = canonicalAuthor;
	manifest.authorVendors = canonicalAuthors;
	manifest.reviews.push({
		reviewId,
		generation,
		phase,
		reviewerVendor,
		reviewerModel,
		reportPath: relativeReportPath,
		findingsCount: findings.length,
		ungroundedFindingsCount: ungroundedFindings.length,
		hasP1,
		operationId,
		reviewedAt,
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

	const record = validateCriticReviewRecord({
		schemaVersion: '1.0.0',
		reviewId,
		runId,
		generation,
		phase,
		reviewerVendor,
		reviewerModel,
		artifactHash,
		attemptKey,
		manifestPath: relativeManifestPath,
		findingsCount: findings.length,
		hasP1,
		reviewedAt,
		operationId,
		usageRecordIds,
		findingsJson: JSON.stringify(findings),
		reportArtifact: relativeReportPath,
	});
	if (runtimeStore) {
		runtimeStore.saveCriticReview(record);
	}

	return { reviewId, report, reportPath: relativeReportPath, manifestPath: relativeManifestPath };
}
