// Shared builders for critic review specs.

export interface CriticGovernorOptions {
	vendor?: string;
	model?: string;
	output?: unknown;
	usageRecordIds?: string[];
}

export interface CriticGovernorRequest {
	operationId: string;
	[key: string]: unknown;
}

export class FakeGovernorForCritic {
	vendor: string;
	model: string;
	output: unknown;
	usageRecordIds: string[];
	calls: CriticGovernorRequest[];

	constructor({ vendor = 'openai', model = 'gpt-4o', output, usageRecordIds = ['rec-1'] }: CriticGovernorOptions = {}) {
		this.vendor = vendor;
		this.model = model;
		this.output = output ?? { status: 'PASS', findings: [] };
		this.usageRecordIds = usageRecordIds;
		this.calls = [];
	}

	async execute(request: CriticGovernorRequest) {
		this.calls.push(structuredClone(request));
		return Object.freeze({
			schemaVersion: '1.0.0',
			synthetic: true,
			output: structuredClone(this.output),
			operationId: request.operationId,
			route: Object.freeze({
				routeId: `route-${this.vendor}`,
				provider: this.vendor,
				model: this.model,
				canonicalVendor: this.vendor,
			}),
			usageRecordIds: Object.freeze([...this.usageRecordIds]),
		});
	}
}

export interface ReviewRecordOptions {
	artifactHash: string;
	attemptKey?: string;
	hasP1?: boolean;
	phase?: string;
	findingsJson?: string;
}

export function reviewRecord(runId: string, { artifactHash, attemptKey = 'spec:0', hasP1 = false, phase = 'spec', findingsJson }: ReviewRecordOptions) {
	return {
		schemaVersion: '1.0.0',
		reviewId: `rev-${artifactHash.slice(0, 8)}`,
		runId,
		generation: 0,
		phase,
		reviewerVendor: 'openai',
		reviewerModel: 'gpt-4o',
		manifestPath: `tools/.review/${runId}/manifest.json`,
		artifactHash,
		attemptKey,
		findingsCount: hasP1 ? 1 : 0,
		hasP1,
		reviewedAt: new Date().toISOString(),
		...(findingsJson ? { findingsJson } : {}),
	};
}
