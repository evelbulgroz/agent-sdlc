import type { CommandRegistration } from '../policy/contracts/quality-evidence-schema.ts';
import type { AcceptanceConfig } from './types.ts';
import { engineContracts, type EvidenceContracts } from './contracts.ts';
import type { CanaryQualityPolicy, ExperimentConfiguration, RoleRecord } from './experiment-types.ts';
import { readJson } from './primitives.ts';

// Parsed JSON is trusted only through these structural types; the engine contracts enforce schemas at runtime.
export type JsonRecord = Record<string, unknown>;

export const readAs = <T>(file: string): T => readJson(file) as T;

interface Parser { parse(value: unknown): unknown }

// The engine contract surface admission calls beyond the evidence wire schemas.
export type AdmissionContracts = EvidenceContracts & {
  QualityPolicySchema: { parse(value: unknown): CanaryQualityPolicy };
  AdapterRegistrationSchema: Parser;
  validateRunAuthorization(value: unknown): unknown;
};

export const admissionContracts = async (): Promise<AdmissionContracts> => await engineContracts() as AdmissionContracts;

export interface FileReference {
  path: string;
  sha256: string;
  schemaVersion?: string;
}

export type BindingName =
  | 'engineBuildAndDependencies' | 'hostProfile' | 'runtimeInventory' | 'adapterRegistrations'
  | 'pretestEquivalenceReceipt' | 'canonicalPreflightClosure' | 'candidatePreparationManifests'
  | 'corpusAndExpectedOutcomes' | 'offlineQualificationReceipt' | 'semanticQualificationPackets'
  | 'caseIdentityMap' | 'approvedRunSpecsAndTaskPlans' | 'resolvedGovernorPolicyAndRoutes'
  | 'resolvedRoleDefinitions' | 'promptFitMeasurements' | 'routePricesAndReservationInventory'
  | 'controllerAndContainmentReceipts' | 'allowedCommandsAndEnvironment'
  | 'artifactOwnershipAndRetention' | 'runAuthorizations';

export type GateName = 'integrationPreflightReceipt' | 'implementationApprovalReceipt' | 'liveApprovalReceipt';

export interface RunAuthorization {
  runId: string;
  approvedSpecHash: string;
  baseCommitSha: string;
  [key: string]: unknown;
}

export interface SharedBudget {
  governorStateRoot: string;
  reservationLedger: string;
  [key: string]: unknown;
}

export interface AdmissionManifest {
  manifestVersion: string;
  admission: string;
  hostRoot: string;
  repositoryId: string;
  nodeExecutable: string;
  integrationBaseCommit: string;
  downloadsAllowed: boolean;
  mergeCanary: boolean;
  installationCommands: unknown[];
  allowedPackages: string[];
  allowedPathPrefixes: string[];
  allowedOperations: Record<string, boolean | undefined>;
  qualityPolicy: unknown;
  shared: SharedBudget;
  bindings: Record<BindingName, FileReference> & { nodeExecutableSha256?: string };
  integrationPreflightReceipt: FileReference | null;
  implementationApprovalReceipt: FileReference | null;
  liveApprovalReceipt: FileReference | null;
  [key: string]: unknown;
}

export interface StatusRecord {
  status?: string;
  failures?: unknown[];
  schemaVersion?: string;
  [key: string]: unknown;
}

export interface ControlReceipt extends StatusRecord {
  qualifiedLauncher?: boolean;
  qualificationHash?: string;
  launcherSha256?: string;
  experimentSha256?: string;
  qualityPolicySha256?: string;
  roleDefinitionsSha256?: string;
  allRoleEnforced?: boolean;
  deadlineEnforced?: boolean;
  spendEnforced?: boolean;
  containmentEnforced?: boolean;
}

export interface ScenarioApproval {
  runId: string;
  approvedSpecHash: string;
  spec?: FileReference;
  tasks?: FileReference;
}

export interface ScenarioPreparation {
  runtimeInventory?: FileReference;
  commandRecipes: FileReference;
  workspaceLayout?: FileReference | null;
  dependencyManifests?: FileReference[];
  readOnlyFiles?: FileReference[];
  [key: string]: unknown;
}

export interface ScenarioCommands {
  invocations?: string[][];
  skipCanary?: boolean;
  [key: string]: unknown;
}

export interface AdmissionBindings {
  routePricesAndReservationInventory: { experiment: ExperimentConfiguration; [key: string]: unknown };
  resolvedRoleDefinitions: RoleRecord & { [key: string]: unknown };
  adapterRegistrations: { registrations: CommandRegistration[]; [key: string]: unknown };
  runAuthorizations: { authorizations: RunAuthorization[]; [key: string]: unknown };
  controllerAndContainmentReceipts: ControlReceipt;
  offlineQualificationReceipt: StatusRecord;
  pretestEquivalenceReceipt: StatusRecord;
  approvedRunSpecsAndTaskPlans: { scenarios: Record<string, ScenarioApproval>; [key: string]: unknown };
  candidatePreparationManifests: { scenarios: Record<string, ScenarioPreparation>; [key: string]: unknown };
  allowedCommandsAndEnvironment: { scenarios?: Record<string, ScenarioCommands>; [key: string]: unknown };
  resolvedGovernorPolicyAndRoutes: JsonRecord;
  [key: string]: unknown;
}

export interface GovernorRoute {
  routeId: string;
  provider: string;
  model: string;
  canonicalVendor: string;
  pricingStatus: string;
  enabled?: boolean;
}

export interface GovernorResolution {
  pricingVersion: unknown;
  profiles: Record<string, { routes: GovernorRoute[] }>;
}

export interface CorpusCase { id: string; kind: string; expected: unknown }
export interface Corpus { cases: CorpusCase[]; [key: string]: unknown }

export type AdmissionConfig = AcceptanceConfig;

export type ReferenceFn = (file: string) => FileReference;

export interface ScenarioRecords {
  scenario: string;
  approved: JsonRecord;
  preparation: JsonRecord;
  commands: JsonRecord;
}

export interface CopyEntry {
  source: string;
  sourceRoot: string;
  destination: string;
  sha256: string;
  mode: number;
}

export interface Recipe {
  id: string;
  inputArgv: string[];
  argv: string[];
  executableSha256: string;
  dependencyManifest: FileReference;
  timeoutMs: number;
  cwd: string;
  files: FileReference[];
}
