import fs from 'node:fs';
import path from 'node:path';
import { fail } from './primitives.mjs';

/**
 * Resolves a loaded host profile's acceptanceEvidence block into the constants the evidence modules share.
 * Pure and import-free so it runs from source and from dist. Fails closed: a profile without the block
 * never inherits defaults.
 */
export function acceptanceConfig(profile, root) {
	const block = profile.acceptanceEvidence;
	if (!block) fail('acceptanceEvidence is not configured in .agents/sdlc-host.json');
	return Object.freeze({
		root: path.resolve(root),
		profileId: profile.profileId,
		canaryId: block.canaryId,
		slug: block.slug,
		packageRoot: block.package.root,
		openApiPath: block.package.openApiPath ?? null,
		readOnlyBinds: Object.freeze([...block.sandbox.readOnlyBinds]),
		output: `${block.evidenceDir}/${block.canaryId}`,
		runtime: block.runtimeDir,
		helpers: block.helpersDir ?? null,
		node: block.nodeExecutable ?? fs.realpathSync(process.execPath),
		packageManager: block.packageManager ?? null,
		preflightCommand: block.preflightCommand ? Object.freeze([...block.preflightCommand]) : null,
		taskVerificationCommand: block.taskVerificationCommand ? Object.freeze([...block.taskVerificationCommand]) : null,
		repositoryId: profile.repositoryId,
		stateDir: profile.stateDir,
		reviewDir: profile.reviewDir,
		runsDir: profile.runsDir ?? null,
		preflightResult: block.preflightResult ?? null,
		providerCredentials: block.canary?.providerCredentials ?? [],
		canary: block.canary ? Object.freeze({ ...block.canary, files: Object.freeze(block.canary.files.map((file) => Object.freeze({ ...file }))) }) : null,
		caseManifest: block.caseManifest,
		runtimeSources: block.runtimeSources,
		runners: block.runners ?? {},
		commands: block.commands ?? {},
		pretest: block.pretest ?? [],
		sentinel: block.sentinel ?? null,
	});
}
