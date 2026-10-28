export {
	RUNTIME_SCHEMA_VERSION,
	STORE_SCHEMA_VERSION,
	RUNTIME_STATES,
	EVENT_TYPES,
	validateRuntimeState,
	validateEvent,
	createEvent,
	deriveEventId,
} from './contracts/runtime-vocabulary.ts';

export type {
	RuntimeStateName,
	EventType,
	RuntimeLastError,
	RuntimeState,
	RuntimeEvent,
} from './contracts/runtime-vocabulary.ts';

export {
	RELIABILITY_SCHEMA_VERSION,
	RELIABILITY_FAILURE_CATEGORIES,
	validateFalseEconomyDiagnostic,
	validateMutationAttempt,
	validateVerificationAttempt,
	validateRouteAttribution,
	validateCanaryQualification,
} from './contracts/reliability-records.ts';

export type {
	ReliabilityFailureCategory,
	FalseEconomyDiagnostic,
	MutationAttemptRecord,
	MutationAttempt,
	VerificationAttemptRecord,
	VerificationAttempt,
	RouteAttributionRecord,
	RouteAttribution,
	CanaryQualificationRecord,
	CanaryQualification,
} from './contracts/reliability-records.ts';

export {
	VALID_ATTRIBUTION_PHASES,
	ROLE_KINDS,
	INSERTION_POINTS,
	validateWorkflowDefinition,
	validateRoleId,
	validateRoleDefinition,
} from './contracts/role-schema.ts';

export type {
	AttributionPhase,
	RoleKind,
	InsertionPoint,
	WorkflowLimits,
	WorkflowPipelines,
	WorkflowDefinition,
	RoleRequestedLimits,
	RoleDefinition,
} from './contracts/role-schema.ts';

export {
	DRAFT_FIELDS,
	ARRAY_DRAFT_FIELDS,
	emptyDraft,
	validateDraft,
	validatePatch,
	validateCompleteness,
	validateQuestionBatch,
	validateAnswerDocument,
	validateApprovalResponse,
} from './contracts/draft-schema.ts';

export type {
	DraftField,
	SpecDraft,
	SpecificationDraft,
	DraftPatchOperation,
	CompletenessEvaluation,
	QuestionItem,
	QuestionBatch,
	AnswerItem,
	AnswerDocument,
	ApprovalResponse,
} from './contracts/draft-schema.ts';

export {
	TERMINAL_STATES,
	ALLOWED_TRANSITIONS,
	assertTransition,
} from './contracts/runtime-transitions.ts';

export {
	GIT_SHA,
	normalizeText,
	normalizedValue,
	canonicalJson,
	sha256,
	validateRunId,
	validateOpaqueId,
} from './contracts/primitives.ts';

export {
	TASK_MANIFEST_SCHEMA_VERSION,
	TASK_MANIFEST_SLICE_KINDS,
	TASK_MANIFEST_DELIVERY_LAYERS,
	validateTaskManifest,
	validateTaskManifestAcceptanceCriteria,
} from './contracts/planning-schema.ts';

export type {
	TaskManifestSliceKind,
	SliceKind,
	TaskManifestDeliveryLayer,
	DeliveryLayer,
	ChangeClass,
	DependencyMutation,
	ShadowPaths,
	ShadowPathDeclarations,
	ManifestSlice,
	TaskSlice,
	ManifestTask,
	TaskManifest,
} from './contracts/planning-schema.ts';

export {
	ALLOWED_TOOLS,
	validateGeneration,
	validateToolExecution,
	validateGitCommitRecord,
	validatePullRequestRecord,
} from './contracts/execution-records.ts';

export type {
	AllowedToolName,
	OracleSnapshotItem,
	GenerationRecord,
	ToolExecutionRecord,
	GitCommitRecord,
	PullRequestRecord,
} from './contracts/execution-records.ts';

export {
	SEVERITIES,
	FAILURE_CLASSIFICATIONS,
	validateReviewFindings,
	validateFailurePacket,
	validatePreflightBinding,
	validateCriticReviewRecord,
	validateOptionalRoleRecord,
} from './contracts/review-records.ts';

export type {
	Severity,
	FailureClassification,
	ReviewFindingItem,
	ReviewFindingsRecord,
	FailurePacketRecord,
	PreflightBindingRecord,
	CriticReviewRecord,
	OptionalRoleRecord,
} from './contracts/review-records.ts';

export {
	CONTINUATION_ACTIONS,
	CONTINUATION_REASONS,
	validateContinuation,
	HOST_INVOCATION_KEYS,
	HOST_FORBIDDEN_FLAGS,
	HOST_APPROVAL_CHOICES,
	HOST_PLAN_CRITIC_CHOICES,
	HOST_RECONCILIATION_CHOICES,
	HOST_HIGH_RISK_REVIEW_CHOICES,
	hostInvocationChangeSlots,
	validateHostInvocation,
} from './contracts/host-invocation-schema.ts';

export type {
	ContinuationAction,
	ContinuationReason,
	ContinuationRecord,
	HostInvocationChangeSlot,
	ResponseQuestionSlot,
	ResponseSlot,
	HostInvocationRecord,
} from './contracts/host-invocation-schema.ts';

export {
	validateRunAuthorization,
} from './contracts/run-authorization-schema.ts';

export type {
	AllowedOperations,
	RunAuthorizationRecord,
	RunAuthorization,
} from './contracts/run-authorization-schema.ts';

export {
	TaskStatusSchema,
	DagTaskSchema,
	TaskPlanSchema,
	ReconciliationRecordSchema,
	validateDagTask,
	validateTaskPlan,
	validateReconciliationRecord,
} from './contracts/dag-schema.ts';

export type {
	TaskStatus,
	DagTask,
	TaskPlan,
	ReconciliationRecord,
} from './contracts/dag-schema.ts';

export {
	VALID_PROMPT_ROLES,
	VALID_FRICTION_SIGNALS,
	CLOSED_FRICTION_CATEGORIES,
	validateFindingKey,
	resolveAggregatedAttributionLayer,
	validateProposedDiff,
	SkillFindingsSyncArtifactSchema,
	AppliedSkillsRegistrySchema,
	applyPatchToContent,
} from './contracts/skill-learning-schema.ts';

export type {
	PromptRole,
	FrictionSignal,
	ValidatedFindingKey,
	SkillFindingsSyncArtifact,
	AppliedSkillsRegistry,
} from './contracts/skill-learning-schema.ts';
