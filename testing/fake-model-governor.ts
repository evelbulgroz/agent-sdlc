import type { GovernorExecuteResult } from '../execution/minimal-executor-types.ts';
import { SdlcError } from '../policy/errors.ts';

export interface FakeGovernorRequest {
	operationId?: string;
	profile?: string;
	prompt?: string;
	routingConstraints?: { excludedVendors?: readonly string[] };
	[key: string]: unknown;
}

export interface FakeGovernorEnvelope {
	output?: { action?: { kind?: string; gather?: unknown; verificationCommand?: unknown } } | null;
	[key: string]: unknown;
}

export interface CriticScriptItem {
	__role: 'critic';
	output?: unknown;
	status?: string;
	findings?: unknown[];
	canonicalVendor?: string;
}

export type CriticHandler = ((request: FakeGovernorRequest) => unknown) & { handlesCritic?: boolean };

export type FakeGovernorScriptItem =
	| Error
	| CriticHandler
	| CriticScriptItem
	| object;

function isCriticItem(item: FakeGovernorScriptItem | undefined): item is CriticScriptItem {
	return typeof item === 'object' && item !== null && !(item instanceof Error) && (item as { __role?: unknown }).__role === 'critic';
}

function namedEditCommand(prompt: unknown): string[] | null {
	const match = String(prompt ?? '').match(/verificationCommand on an edit is ([^\n]+)\./);
	if (!match?.[1]) return null;
	const command = match[1].split(' ').filter((part) => part.length > 0);
	return command[0] === 'pnpm' ? command : null;
}

// A scripted edit that leaves the command empty echoes the pnpm argv the prompt
// names. An explicit array stays as written, so a test can still send another command.
function echoNamedEditCommand(envelope: unknown, request?: FakeGovernorRequest): unknown {
	const action = (envelope as FakeGovernorEnvelope | null | undefined)?.output?.action;
	if (!action || action.kind !== 'programmer_turn' || action.gather) return envelope;
	if (Array.isArray(action.verificationCommand)) return envelope;
	const command = namedEditCommand(request?.prompt);
	if (!command) return envelope;
	const cloned = structuredClone(envelope) as FakeGovernorEnvelope;
	const clonedAction = cloned.output?.action;
	if (clonedAction) clonedAction.verificationCommand = command;
	return cloned;
}

export class FakeModelGovernor {
	script: FakeGovernorScriptItem[];
	calls: FakeGovernorRequest[];
	reserveCalls: FakeGovernorRequest[];
	portVersion: string;
	synthetic: boolean;

	constructor(script: readonly FakeGovernorScriptItem[] = []) {
		this.script = [...script];
		this.calls = [];
		this.reserveCalls = [];
		this.portVersion = '1.0.0';
		this.synthetic = true;
	}

	async assertCanReserve(request: FakeGovernorRequest): Promise<void> {
		this.reserveCalls.push(structuredClone(request));
	}

	async assertAvailable(): Promise<boolean> {
		return true;
	}

	async execute(request: FakeGovernorRequest): Promise<GovernorExecuteResult> {
		this.calls.push(structuredClone(request));
		if (request.profile === 'critic-review') {
			const peeked = this.script[0];
			if (typeof peeked === 'function' && (peeked as CriticHandler).handlesCritic === true) {
				return (peeked as CriticHandler)(request) as GovernorExecuteResult;
			}
			if (peeked instanceof Error) {
				throw this.script.shift();
			}
			if (isCriticItem(peeked)) {
				const item = peeked;
				this.script.shift();
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
		if (typeof next === 'function') return echoNamedEditCommand(await next(request), request) as GovernorExecuteResult;
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
		) as GovernorExecuteResult;
	}
}
