import path from 'node:path';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { SdlcError } from '../policy/errors.ts';
import { citingSpecWriteAction, completeProposal, leanWriteAction } from './test-support-fixtures.mjs';

export function createSlice2SmartGovernor({
	failReview = false,
	failReviewFirstNCalls = 0,
} = {}) {
	let implementerCalls = 0;
	let reviewCalls = 0;
	let repairerCalls = 0;

	const handler = (request) => {
		const role = request.attribution?.roleId ?? request.role ?? 'drafter';
		if (role === 'critic-reviewer' || request.profile === 'critic-review') {
			const excluded = request.routingConstraints?.excludedVendors ?? [];
			const vendor = excluded.includes('openai') ? 'google' : 'openai';
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: { status: 'PASS', findings: [] },
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-critic-route',
					provider: vendor,
					model: 'deterministic-json',
					canonicalVendor: vendor,
				}),
			};
		}
		if (role === 'drafter') {
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: completeProposal(),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'implementer') {
			implementerCalls++;
			const output =
				implementerCalls === 1
					? leanWriteAction('tools/example.mjs', 'export const feature = true;\n')
					: implementerCalls === 2
						? citingSpecWriteAction('tools/example.spec.mjs')
						: implementerCalls === 3
							? {
									action: {
										kind: 'tool_call',
										toolName: 'run_allowlisted_command',
										parameters: {
											command: 'pnpm',
											args: ['run', 'test:unit'],
										},
									},
								}
						: {
								action: {
									kind: 'complete',
									summary: 'Implemented billing feature',
								},
							};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'reviewer') {
			reviewCalls++;
			const shouldFail =
				failReview || reviewCalls <= failReviewFirstNCalls;
			const output = shouldFail
				? {
						status: 'FAIL',
						summary: 'Review found P1 defect',
						findings: [
							{
								findingId: 'finding-1',
								severity: 'P1',
								category: 'correctness',
								path: 'services/billing/src/feature.ts',
								lineRange: [1, 1],
								evidence: 'export const feature = true;',
								failureMechanism: 'Must be number',
								remediation: 'Change to number',
							},
						],
					}
				: {
						status: 'PASS',
						summary: 'Review looks good',
						findings: [],
					};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'repairer') {
			repairerCalls++;
			const output =
				repairerCalls === 1
					? leanWriteAction(
							'services/billing/src/feature.ts',
							'export const feature = 42;\n',
						)
					: {
							action: {
								kind: 'complete',
								summary: 'Repaired defect',
							},
						};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		throw new SdlcError('UNKNOWN_ROLE', `Unexpected role: ${role}`);
	};

	return new FakeModelGovernor(Array(50).fill(handler));
}

export function multiPackageProposal(
	surfaces = ['packages/shared-base', 'services/billing'],
	owningContext = 'Monorepo Tooling',
) {
	const proposal = completeProposal();
	const touchedIdx = proposal.patch.findIndex((p) => p.field === 'touchedSurfaces');
	if (touchedIdx !== -1) {
		proposal.patch[touchedIdx].value = surfaces;
	}
	const contextIdx = proposal.patch.findIndex((p) => p.field === 'owningContext');
	if (contextIdx !== -1) {
		proposal.patch[contextIdx].value = owningContext;
	}
	return proposal;
}

export function createSlice4SmartGovernor({
	surfaces = ['packages/shared-base', 'services/billing'],
	failReview = false,
} = {}) {
	const taskCalls = new Map();
	let reviewCalls = 0;

	const handler = (request) => {
		const role = request.attribution?.roleId ?? request.role ?? 'drafter';
		if (role === 'critic-reviewer' || request.profile === 'critic-review') {
			const excluded = request.routingConstraints?.excludedVendors ?? [];
			const vendor = excluded.includes('openai') ? 'google' : 'openai';
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: { status: 'PASS', findings: [] },
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-critic-route',
					provider: vendor,
					model: 'deterministic-json',
					canonicalVendor: vendor,
				}),
			};
		}
		if (role === 'drafter') {
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: multiPackageProposal(surfaces),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'implementer') {
			const taskId = request.attribution?.taskId || 'default';
			const callKey = `${taskId}:${role}`;
			const count = (taskCalls.get(callKey) || 0) + 1;
			taskCalls.set(callKey, count);
			const isChild =
				taskId.includes('billing') ||
				taskId === 'task-1' ||
				taskId === 'child-task';
			const targetPackage = isChild ? surfaces[1] : surfaces[0];
			const targetPath =
				targetPackage.endsWith('.ts') || targetPackage.endsWith('.mjs')
					? targetPackage
					: path.posix.join(targetPackage, 'src/feature.ts');
			const specPath = path.posix.join(path.posix.dirname(targetPath), 'feature.spec.ts');
			const output =
				count === 1
					? leanWriteAction(targetPath, `export const feature = '${taskId}';\n`)
					: count === 2
						? citingSpecWriteAction(specPath)
						: {
								action: {
									kind: 'complete',
									summary: `Implemented ${targetPath}`,
								},
							};
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		if (role === 'reviewer') {
			reviewCalls++;
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: {
					status: 'PASS',
					summary: 'All tasks passed unified review',
					findings: [],
				},
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			};
		}
		throw new SdlcError('UNKNOWN_ROLE', `Unexpected role: ${role}`);
	};

	return new FakeModelGovernor(Array(50).fill(handler));
}
