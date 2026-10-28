import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';
import { resolveLocalPolicyPath } from '../policy/local-policy-fingerprint.ts';

const GOVERNOR_PORT_VERSION = '1.0.0';
const DEFAULT_GOVERNOR_FILE = fileURLToPath(import.meta.resolve('@fitness-app/model-usage'));

export interface GovernorRouteIdentity {
	readonly routeId: string;
	readonly provider: string;
	readonly model: string;
	readonly canonicalVendor: string;
}

export interface GovernorPortResult {
	readonly schemaVersion: string;
	readonly synthetic: boolean;
	readonly output: unknown;
	readonly operationId: string;
	readonly replayed: boolean;
	readonly usageRecordIds: readonly string[];
	readonly attempts: number;
	readonly attemptedRoutes: readonly GovernorRouteIdentity[];
	readonly effectiveStrategy?: string;
	readonly selectedQualityTier?: number;
	readonly counterfactualTier2CostMicrousd?: number | null;
	readonly route: GovernorRouteIdentity | null;
}

export type GovernorExecuteFn = (
	request: unknown,
	options?: Record<string, unknown>,
) => Promise<unknown>;

export type GovernorAssessFn = (
	request: unknown,
	options?: Record<string, unknown>,
) => Promise<unknown>;

export interface RepositoryModelGovernorOptions {
	execute?: unknown;
	assessReservation?: unknown;
	executeOptions?: Record<string, unknown>;
	governorPath?: string;
	portVersion?: string;
	rootDir?: string;
	localPolicyPath?: string | null;
}

export class RepositoryModelGovernor {
	executeOperation: GovernorExecuteFn | null;
	assessReservation: GovernorAssessFn | null;
	readonly executeOptions: Record<string, unknown>;
	readonly governorPath: string;
	readonly portVersion: string;
	readonly synthetic: boolean;

	constructor({
		execute,
		assessReservation,
		executeOptions = {},
		governorPath = DEFAULT_GOVERNOR_FILE,
		portVersion = GOVERNOR_PORT_VERSION,
		rootDir,
		localPolicyPath = null,
	}: RepositoryModelGovernorOptions = {}) {
		if (execute !== undefined && typeof execute !== 'function') {
			throw new SdlcError('GOVERNOR_UNAVAILABLE', 'Model Usage Governor is unavailable');
		}
		this.executeOperation = typeof execute === 'function' ? (execute as GovernorExecuteFn) : null;
		this.assessReservation =
			typeof assessReservation === 'function' ? (assessReservation as GovernorAssessFn) : null;
		const resolvedHostPolicyPath =
			typeof localPolicyPath === 'string' && localPolicyPath.length > 0
				? path.resolve(localPolicyPath)
				: typeof rootDir === 'string' &&
					  rootDir.length > 0 &&
					  !process.env.MODEL_USAGE_DEFAULT_LOCAL_POLICY_PATH
					? resolveLocalPolicyPath(rootDir)
					: undefined;
		this.executeOptions =
			resolvedHostPolicyPath !== undefined &&
			executeOptions.localPolicyPath === undefined &&
			executeOptions.defaultLocalPolicyPath === undefined
				? { defaultLocalPolicyPath: resolvedHostPolicyPath, ...executeOptions }
				: executeOptions;
		this.governorPath = governorPath;
		this.portVersion = portVersion;
		this.synthetic = false;
	}

	async assertAvailable(): Promise<boolean> {
		if (this.portVersion !== GOVERNOR_PORT_VERSION) {
			throw new SdlcError('GOVERNOR_UNAVAILABLE', 'Model Usage Governor port is incompatible');
		}
		if (this.executeOperation && typeof this.executeOperation !== 'function') {
			throw new SdlcError('GOVERNOR_UNAVAILABLE', 'Model Usage Governor is unavailable');
		}
		if (!this.executeOperation) {
			if (!fs.existsSync(this.governorPath)) {
				throw new SdlcError(
					'GOVERNOR_UNAVAILABLE',
					`Model Usage Governor entrypoint not found: ${this.governorPath}`,
				);
			}
			try {
				const governorUrl = pathToFileURL(this.governorPath).href;
				const mod = (await import(governorUrl)) as Record<string, unknown>;
				if (typeof mod.executeOperation !== 'function') {
					throw new SdlcError(
						'GOVERNOR_UNAVAILABLE',
						'Model Usage Governor does not export executeOperation',
					);
				}
				this.executeOperation = mod.executeOperation as GovernorExecuteFn;
			} catch (error: unknown) {
				if (error instanceof SdlcError) throw error;
				const msg =
					error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
						? error.message
						: String(error);
				throw new SdlcError(
					'GOVERNOR_UNAVAILABLE',
					`Failed to load Model Usage Governor: ${msg}`,
					{},
					{ cause: error },
				);
			}
		}
		return true;
	}

	getRunOperations(runId: string): Record<string, unknown> {
		const stateRoot =
			typeof this.executeOptions?.stateRoot === 'string' ? this.executeOptions.stateRoot : null;
		const ledgerPath = stateRoot
			? path.join(stateRoot, 'runs', `${runId}.json`)
			: path.join(REPOSITORY_ROOT, 'tools/.model-usage/runs', `${runId}.json`);
		if (!fs.existsSync(ledgerPath)) return {};
		try {
			const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
				operations?: Record<string, unknown>;
			};
			return raw?.operations ?? {};
		} catch {
			return {};
		}
	}

	async assertCanReserve(request: unknown): Promise<unknown> {
		let assess = this.assessReservation;
		if (typeof assess !== 'function') {
			await this.assertAvailable();
			const governorUrl = pathToFileURL(this.governorPath).href;
			const mod = (await import(governorUrl)) as Record<string, unknown>;
			if (typeof mod.assessReservation !== 'function') {
				throw new SdlcError(
					'GOVERNOR_UNAVAILABLE',
					'Model Usage Governor does not export assessReservation',
				);
			}
			assess = mod.assessReservation as GovernorAssessFn;
			this.assessReservation = assess;
		}
		try {
			return await assess(request, this.executeOptions);
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw mapGovernorError(error);
		}
	}

	async execute(request: unknown): Promise<GovernorPortResult> {
		await this.assertAvailable();
		try {
			if (!this.executeOperation) {
				throw new SdlcError('GOVERNOR_UNAVAILABLE', 'Model Usage Governor is unavailable');
			}
			const rawResult = await this.executeOperation(request, this.executeOptions);
			const result =
				rawResult && typeof rawResult === 'object' ? (rawResult as Record<string, unknown>) : null;
			if (!result || result.schemaVersion !== GOVERNOR_PORT_VERSION || result.status !== 'succeeded') {
				throw new SdlcError('GOVERNOR_UNAVAILABLE', 'Governor returned an incompatible result');
			}
			const rawRoute =
				result.route && typeof result.route === 'object'
					? (result.route as Record<string, unknown>)
					: null;
			const rawAttemptedRoutes = Array.isArray(result.attemptedRoutes)
				? (result.attemptedRoutes as Record<string, unknown>[])
				: rawRoute
					? [rawRoute]
					: [];
			return Object.freeze({
				schemaVersion: GOVERNOR_PORT_VERSION,
				synthetic: false,
				output: result.output,
				operationId: String(result.operationId),
				replayed: Boolean(result.replayed),
				usageRecordIds: Object.freeze(
					Array.isArray(result.usageRecordIds) ? (result.usageRecordIds as string[]) : [],
				),
				attempts: typeof result.attempts === 'number' ? result.attempts : 1,
				attemptedRoutes: Object.freeze(
					rawAttemptedRoutes.map((route) =>
						Object.freeze({
							routeId: String(route.routeId),
							provider: String(route.provider),
							model: String(route.model),
							canonicalVendor: String(route.canonicalVendor),
						}),
					),
				),
				effectiveStrategy:
					typeof result.effectiveStrategy === 'string' ? result.effectiveStrategy : undefined,
				selectedQualityTier:
					typeof result.selectedQualityTier === 'number' ? result.selectedQualityTier : undefined,
				counterfactualTier2CostMicrousd:
					typeof result.counterfactualTier2CostMicrousd === 'number' ||
					result.counterfactualTier2CostMicrousd === null
						? result.counterfactualTier2CostMicrousd
						: undefined,
				route: rawRoute
					? Object.freeze({
							routeId: String(rawRoute.routeId),
							provider: String(rawRoute.provider),
							model: String(rawRoute.model),
							canonicalVendor: String(rawRoute.canonicalVendor),
						})
					: null,
			});
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw mapGovernorError(error);
		}
	}
}

function mapGovernorError(error: unknown): SdlcError {
	const errObj =
		error && typeof error === 'object'
			? (error as { code?: unknown; message?: unknown; metadata?: unknown })
			: null;
	const metadata =
		errObj?.metadata && typeof errObj.metadata === 'object' && !Array.isArray(errObj.metadata)
			? (errObj.metadata as Record<string, unknown>)
			: {};
	const code = typeof errObj?.code === 'string' ? errObj.code : '';
	const message = typeof errObj?.message === 'string' ? errObj.message : '';
	switch (code) {
		case 'ERR_BUDGET_RESERVATION_DENIED':
		case 'ERR_TOKEN_BUDGET_EXCEEDED':
		case 'ERR_CALL_BUDGET_EXCEEDED':
		case 'ERR_COST_BUDGET_EXCEEDED': {
			const dimension = metadata.dimension ?? 'budget';
			const detail =
				metadata.limit !== undefined
					? ` (${metadata.reason ? `${String(metadata.reason)} ` : ''}${String(dimension)} exceeded: limit=${String(metadata.limit)}, requested=${String(metadata.requested ?? 'unknown')}, remaining=${String(metadata.remaining ?? 'unknown')})`
					: '';
			return new SdlcError(
				'GOVERNOR_BUDGET_DENIED',
				`Governor denied the operation budget${detail}`,
				metadata,
				{
					cause: error,
				},
			);
		}
		case 'ERR_CONCURRENCY_LIMIT':
		case 'ERR_OPERATION_IN_PROGRESS':
			return new SdlcError(
				'GOVERNOR_CONCURRENCY_DENIED',
				'Governor denied concurrent execution',
				metadata,
				{ cause: error },
			);
		case 'ERR_RUN_DEADLINE_EXPIRED':
			return new SdlcError(
				'GOVERNOR_RUN_DEADLINE_EXPIRED',
				message || 'Run deadline has expired',
				metadata,
				{ cause: error },
			);
		case 'ERR_ALL_ALLOWED_ROUTES_EXHAUSTED':
		case 'ERR_OPERATION_TIMEOUT':
			return new SdlcError(
				'GOVERNOR_ROUTES_EXHAUSTED',
				'No allowed governed model route completed',
				metadata,
				{ cause: error },
			);
		default:
			return new SdlcError(
				'GOVERNOR_UNAVAILABLE',
				message
					? `Model Usage Governor failed: ${message}`
					: 'Model Usage Governor failed before producing a valid result',
				metadata,
				{ cause: error },
			);
	}
}
