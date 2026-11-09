import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvidenceReport, EvidenceRequest } from '../policy/contracts/quality-evidence-schema.ts';
import { engineModule, fail, regularFile, relativePath } from './primitives.ts';

/** The slice of the pinned contract module the acceptance code calls. */
export interface EvidenceContracts {
	EvidenceRequestSchema: { parse(value: unknown): EvidenceRequest };
	EvidenceReportSchema: { parse(value: unknown): EvidenceReport };
	sha256(value: unknown): string;
}
export type ContractsLoader = () => Promise<EvidenceContracts>;

export interface CaseMapEntry {
	file: string;
	caseKey: string;
	kind: string;
	runnerTitle: string;
	capabilities: string[];
	[key: string]: unknown;
}
export type CaseSelection = CaseMapEntry & { obligationIds: string[] };

export const engineContracts: ContractsLoader = () => engineModule('policy/contracts');

/** Loads the pinned wire-contract copy from the runtime directory, never from the live engine. */
export function wireContracts(runtimeDir: string): ContractsLoader {
	return async () => {
		const directory = path.resolve(process.cwd(), runtimeDir, 'engine/policy/contracts');
		const evidence = await import(pathToFileURL(regularFile(directory, 'quality-evidence-schema.ts')).href);
		const primitives = await import(pathToFileURL(regularFile(directory, 'primitives.ts')).href);
		return { ...evidence, ...primitives };
	};
}

export async function readRequest(loadContracts: ContractsLoader, stream: AsyncIterable<string | Buffer> = process.stdin): Promise<EvidenceRequest> {
	let input = '';
	for await (const chunk of stream) {
		input += chunk;
		if (Buffer.byteLength(input) > 1048576) fail('request exceeds 1 MiB');
	}
	const contracts = await loadContracts();
	return contracts.EvidenceRequestSchema.parse(JSON.parse(input));
}

export async function report(loadContracts: ContractsLoader, request: EvidenceRequest, cases: EvidenceReport['cases'], artifacts: EvidenceReport['artifacts'] = []): Promise<EvidenceReport> {
	const contracts = await loadContracts();
	return contracts.EvidenceReportSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId,
		requestHash: contracts.sha256(request), adapterBindingHash: request.adapterBindingHash,
		profileId: request.profileId, cases, artifacts,
	});
}

export function caseSelections(request: EvidenceRequest, caseMap: readonly CaseMapEntry[], kind: string, packageRoot: string): CaseSelection[] {
	if (!Array.isArray(caseMap) || caseMap.length === 0) fail('empty case map');
	const selections = new Map<string, CaseSelection>();
	for (const obligation of request.obligations) {
		for (const selected of obligation.testCases) {
			const entries = caseMap.filter((entry) => entry.file === selected.file
				&& entry.caseKey === selected.caseKey && entry.kind === kind);
			if (entries.length !== 1) fail(`ambiguous/unknown case: ${selected.caseKey}`);
			const entry = entries[0] as CaseMapEntry;
			relativePath(entry.file);
			if (!entry.file.startsWith(`${packageRoot}/`) || !entry.runnerTitle
				|| !Array.isArray(entry.capabilities)) fail('invalid case mapping');
			if (obligation.requiredCapabilities.some((cap) => !entry.capabilities.includes(cap))) {
				fail(`unqualified capability: ${selected.caseKey}`);
			}
			const identity = `${entry.file}\0${entry.caseKey}`;
			const previous = selections.get(identity);
			selections.set(identity, {
				...entry, obligationIds: [...new Set([...(previous?.obligationIds ?? []), obligation.obligationId])],
			});
		}
	}
	if (!selections.size) fail('empty selection');
	return [...selections.values()];
}
