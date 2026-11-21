import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareStartObligations, qualityPlanForStoredObligations } from './product-obligations-file.ts';

const command = {
	argv: ['node', '{reportPath}'],
	cwd: 'pkg',
	layer: 'unit',
	pins: [{ file: 'pin.txt' }],
};

const acceptance = {
	canaryId: 'canary-v1',
	slug: 'demo-canary',
	evidenceDir: 'tools/evidence',
	runtimeDir: 'tools/runtime',
	caseManifest: 'tools/corpus.json',
	runtimeSources: 'tools/sources.json',
	package: { root: 'pkg' },
	sandbox: { readOnlyBinds: [] },
	commands: { unit: { argv: ['node', 'ok'], cwd: 'pkg' } },
	canary: {
		spec: 'docs/specs/canary/acceptance.md',
		tasks: 'docs/specs/canary/acceptance.tasks.json',
		corpus: 'tools/corpus.json',
		obligations: 'tools/obligations.json',
		files: [{ path: 'pkg/case.spec.mjs', kind: 'unit' }],
	},
};

function writeProfile(root) {
	fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
	fs.mkdirSync(path.join(root, 'docs/specs/canary'), { recursive: true });
	fs.writeFileSync(path.join(root, 'docs/specs/canary/qualification.md'), '# qualification fixture\n');
	fs.writeFileSync(path.join(root, 'docs/specs/canary/acceptance.md'), '# acceptance canary\n');
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.7.0',
		profileId: 'demo',
		repositoryId: 'demo',
		adapter: 'default',
		qualificationFixture: { spec: 'docs/specs/canary/qualification.md' },
		acceptanceEvidence: acceptance,
		productEvidence: { packageRoot: 'pkg', commands: { unit: command } },
	}));
}

const draft = { goal: 'Prove the fixture', acceptanceCriteria: ['AC-01: The value is clamped.'], touchedSurfaces: ['pkg/widget.ts'] };

test('declared canary goals skip product obligations when no file is passed', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obligations-exempt-'));
	try {
		writeProfile(root);
		assert.equal(prepareStartObligations({
			rootDir: root, draft, taskManifest: null, obligationsFile: null,
			goalFile: 'docs/specs/canary/qualification.md',
		}), null);
		assert.equal(prepareStartObligations({
			rootDir: root, draft, taskManifest: null, obligationsFile: null,
			goalFile: path.join(root, 'docs/specs/canary/acceptance.md'),
		}), null);
		assert.equal(qualityPlanForStoredObligations({
			rootDir: root, runId: '2026-11-21-demo', draft, taskManifest: null,
			goalText: '# qualification fixture\n',
		}), undefined);
		assert.throws(
			() => prepareStartObligations({
				rootDir: root, draft, taskManifest: null, obligationsFile: null,
				goalFile: 'docs/specs/drafts/feature.md',
			}),
			/product obligations file covering every acceptance case/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
