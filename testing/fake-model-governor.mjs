import { SdlcError } from '../policy/errors.ts';

function namedEditCommand(prompt) {
	const match = String(prompt ?? '').match(/verificationCommand on an edit is ([^\n]+)\./);
	if (!match) return null;
	const command = match[1].split(' ').filter((part) => part.length > 0);
	return command[0] === 'pnpm' ? command : null;
}

// A scripted edit that leaves the command empty echoes the pnpm argv the prompt
// names. An explicit array stays as written, so a test can still send another command.
function echoNamedEditCommand(envelope, request) {
	const action = envelope?.output?.action;
	if (!action || action.kind !== 'programmer_turn' || action.gather) return envelope;
	if (Array.isArray(action.verificationCommand)) return envelope;
	const command = namedEditCommand(request?.prompt);
	if (!command) return envelope;
	const cloned = structuredClone(envelope);
	cloned.output.action.verificationCommand = command;
	return cloned;
}

export class FakeModelGovernor {
	constructor(script = []) {
		this.script = [...script];
		this.calls = [];
		this.reserveCalls = [];
		this.portVersion = '1.0.0';
		this.synthetic = true;
	}

	async assertCanReserve(request) {
		this.reserveCalls.push(structuredClone(request));
	}

	assertAvailable() {
		return true;
	}

	async execute(request) {
		this.calls.push(structuredClone(request));
		if (request.profile === 'critic-review') {
			const peeked = this.script[0];
			if (typeof peeked === 'function' && peeked.handlesCritic === true) {
				return peeked(request);
			}
			if (peeked instanceof Error) {
				throw this.script.shift();
			}
			if (peeked && typeof peeked === 'object' && peeked.__role === 'critic') {
				const item = this.script.shift();
				const output = item.output ?? {
					status: item.status ?? 'PASS',
					findings: item.findings ?? [],
				};
				const excluded = request.routingConstraints?.excludedVendors ?? [];
				const vendor =
					item.canonicalVendor ??
					(excluded.includes('openai') ? 'google' : 'openai');
				return Object.freeze({
					schemaVersion: '1.0.0',
					synthetic: true,
					output: structuredClone(output),
					operationId: request.operationId,
					replayed: false,
					usageRecordIds: Object.freeze([]),
					route: Object.freeze({
						routeId: 'fake-critic-route',
						provider: vendor,
						model: 'deterministic-json',
						canonicalVendor: vendor,
					}),
				});
			}
			const excluded = request.routingConstraints?.excludedVendors ?? [];
			const vendor = excluded.includes('openai') ? 'google' : 'openai';
			return Object.freeze({
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
			});
		}
		if (this.script.length === 0) {
			throw new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'Synthetic governor script exhausted');
		}
		const next = this.script.shift();
		if (next instanceof Error) throw next;
		if (typeof next === 'function') return echoNamedEditCommand(await next(request), request);
		return echoNamedEditCommand(
			Object.freeze({
				schemaVersion: '1.0.0',
				synthetic: true,
				output: structuredClone(next),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
				route: Object.freeze({
					routeId: 'fake-route',
					provider: 'google',
					model: 'deterministic-json',
					canonicalVendor: 'google',
				}),
			}),
			request,
		);
	}
}
