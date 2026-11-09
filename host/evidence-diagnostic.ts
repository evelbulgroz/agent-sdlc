export function sanitizeEvidenceDiagnostic(text: string, maxBytes: number): string {
	return text
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
		.replace(/[^\x20-\x7e\n\t]/g, '?')
		.replace(/(?:[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z_]*\s*[=:]\s*)\S+/gi, '[REDACTED]')
		.replace(/\b(?:Authorization\s*:\s*|Bearer\s+)\S+(?:\s+\S+)?/gi, '[REDACTED]')
		.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
		.replace(/\b(?:sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]+)\b/g, '[REDACTED]')
		.replace(/-----BEGIN[\s\S]*$/g, '[REDACTED]')
		.slice(0, maxBytes);
}
