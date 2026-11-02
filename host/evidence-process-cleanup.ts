import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { EvidenceSpawn } from './evidence-types.ts';

function groupIsRunning(group: number): boolean {
	for (const entry of fs.readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
			const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') return true;
		} catch { /* Processes may exit while /proc is being read. */ }
	}
	return false;
}

export function terminateEvidenceGroup(child: ReturnType<EvidenceSpawn>): void {
	if (process.platform === 'linux' && child.pid !== undefined) {
		try { process.kill(-child.pid, 'SIGKILL'); return; }
		catch { /* Fall back when no process group is available. */ }
	}
	try { child.kill('SIGKILL'); } catch { /* The process may already be gone. */ }
}

export async function awaitEvidenceGroupStopped(child: ReturnType<EvidenceSpawn>): Promise<boolean> {
	if (process.platform !== 'linux' || child.pid === undefined) return true;
	const deadline = Date.now() + 250;
	do {
		if (!groupIsRunning(child.pid)) return true;
		await setTimeout(5);
	} while (Date.now() < deadline);
	return false;
}
