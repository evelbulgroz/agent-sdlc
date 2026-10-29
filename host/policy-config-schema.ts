import { z } from 'zod';

const TokenSchema = z.string().min(1);
const ArgvSchema = z.array(TokenSchema).min(1);

export const ContractProducerRulesSchema = z.strictObject({
	producerPrefixes: z.array(TokenSchema).optional(), excludedProducerPackages: z.array(TokenSchema).optional(),
	excludedProducerPrefixes: z.array(TokenSchema).optional(), consumerPackages: z.array(TokenSchema).optional(),
	consumerPrefixes: z.array(TokenSchema).optional(), downstreamPrefixes: z.array(TokenSchema).optional(),
	sharedPackagePrefixes: z.array(TokenSchema).optional(), contractScripts: z.array(TokenSchema).optional(),
	sharedPackageBuildArgv: ArgvSchema.optional(),
});

export const PolicyConfigSchema = z.strictObject({
	highRiskPaths: z.array(TokenSchema).optional(), protectedBaselinePaths: z.array(TokenSchema).optional(),
	defaultFailureTargetPaths: z.array(TokenSchema).optional(),
	contractProducerRules: ContractProducerRulesSchema.optional(), irreversiblePatterns: z.array(TokenSchema).optional(),
	secretPaths: z.array(TokenSchema).optional(),
});
