import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, regularFile, relativePath } from './primitives.mjs';

export async function engineContracts() {
	if (!process.env.AGENT_SDLC_PATH) fail('AGENT_SDLC_PATH is required');
	return import(pathToFileURL(path.resolve(process.env.AGENT_SDLC_PATH, 'policy/contracts.ts')).href);
}

/** Loads the pinned wire-contract copy from the runtime directory, never from the live engine. */
export function wireContracts(runtimeDir) {
	return async () => {
		const directory = path.resolve(process.cwd(), runtimeDir, 'engine/policy/contracts');
		const evidence = await import(pathToFileURL(regularFile(directory, 'quality-evidence-schema.ts')).href);
		const primitives = await import(pathToFileURL(regularFile(directory, 'primitives.ts')).href);
		return { ...evidence, ...primitives };
	};
}

export async function readRequest(loadContracts, stream = process.stdin) {
	let input = '';
	for await (const chunk of stream) {
		input += chunk;
		if (Buffer.byteLength(input) > 1048576) fail('request exceeds 1 MiB');
	}
	const contracts = await loadContracts();
	return contracts.EvidenceRequestSchema.parse(JSON.parse(input));
}

export async function report(loadContracts, request, cases, artifacts = []) {
	const contracts = await loadContracts();
	return contracts.EvidenceReportSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId,
		requestHash: contracts.sha256(request), adapterBindingHash: request.adapterBindingHash,
		profileId: request.profileId, cases, artifacts,
	});
}

export function caseSelections(request, caseMap, kind, packageRoot) {
	if (!Array.isArray(caseMap) || caseMap.length === 0) fail('empty case map');
	const selections = new Map();
	for (const obligation of request.obligations) {
		for (const selected of obligation.testCases) {
			const entries = caseMap.filter((entry) => entry.file === selected.file
				&& entry.caseKey === selected.caseKey && entry.kind === kind);
			if (entries.length !== 1) fail(`ambiguous/unknown case: ${selected.caseKey}`);
			const entry = entries[0];
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
