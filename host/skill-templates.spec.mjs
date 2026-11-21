import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
	return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('host skill templates keep one home for the shell contract and the obligations shape', () => {
	const shell = read('host/skill-templates/agent-sdlc-shell/SKILL.md');
	const spec = read('host/skill-templates/specification-workflow/SKILL.md');
	const guide = read('docs/handbook/host-skills.md');

	assert.match(shell, /\$AGENT_SDLC_PATH\/cli\/README\.md/);
	assert.match(shell, /specification-workflow` owns the shape/);
	assert.doesNotMatch(shell, /obligationId/);
	assert.doesNotMatch(shell, /schemaVersion/);

	assert.match(spec, /\$AGENT_SDLC_PATH\/cli\/README\.md/);
	assert.match(spec, /"schemaVersion": "1\.0\.0"/);
	assert.match(spec, /"caseId": "AC-01\.1"/);
	assert.match(spec, /\$AGENT_SDLC_PATH\/policy\/README\.md/);
	assert.doesNotMatch(spec, /INVALID_INPUT` and creates no run/);

	assert.match(guide, /host\/skill-templates\/agent-sdlc-shell/);
	assert.match(guide, /host\/skill-templates\/specification-workflow/);
	assert.doesNotMatch(guide, /obligationId/);
	assert.match(read('host/README.md'), /host\/skill-templates/);
	assert.match(read('host/README.md'), /docs\/handbook\/host-skills\.md/);
});
