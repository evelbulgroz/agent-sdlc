import fs from 'node:fs';
import path from 'node:path';

export function writePreflightResult(worktreeDir, result) {
	fs.mkdirSync(path.join(worktreeDir, 'tools'), { recursive: true });
	fs.writeFileSync(path.join(worktreeDir, 'tools/.agent-preflight-last.json'), JSON.stringify(result));
}

export function gitStub({ head, tree }) {
	return (_cmd, args) => {
		if (args[0] === 'status') return '';
		if (args[1] === 'HEAD') return `${head}\n`;
		if (args[1] === 'HEAD^{tree}') return `${tree}\n`;
		throw new Error(`unexpected git ${args.join(' ')}`);
	};
}
