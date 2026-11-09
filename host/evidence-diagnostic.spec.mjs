import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeEvidenceDiagnostic } from './evidence-diagnostic.ts';

test('sanitizeEvidenceDiagnostic redacts secrets, strips control bytes and caps the byte length', () => {
	const text = 'TOKEN=top-secret\nAuthorization: Bearer another-secret\nhttp://user:secret@example.test\n\x1b[31mred\x1b[0m\n' + 'x'.repeat(512);
	const out = sanitizeEvidenceDiagnostic(text, 128);
	assert.ok(Buffer.byteLength(out) <= 128);
	assert.doesNotMatch(out, /top-secret|another-secret|user:secret|\x1b/);
	assert.match(out, /\[REDACTED\]/);
});

test('sanitizeEvidenceDiagnostic redacts private key blocks and well-known key shapes', () => {
	const out = sanitizeEvidenceDiagnostic('key sk-abc123 and AKIAABCDEFGH then -----BEGIN PRIVATE KEY-----\nMIIB', 256);
	assert.doesNotMatch(out, /sk-abc123|AKIAABCDEFGH|MIIB/);
});
