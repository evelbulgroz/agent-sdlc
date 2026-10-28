import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

function denied(name) {
	return function denyNetwork() {
		const marker = process.env.SDLC_TEST_NETWORK_MARKER;
		if (marker) {
			fs.appendFileSync(marker, `${name}\n`, { encoding: 'utf8', mode: 0o600 });
		}
		throw new Error(`NETWORK_DISABLED:${name}`);
	};
}

globalThis.fetch = denied('fetch');
net.connect = denied('net.connect');
net.createConnection = denied('net.createConnection');
tls.connect = denied('tls.connect');
