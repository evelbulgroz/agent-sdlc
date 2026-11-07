import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from './primitives.mjs';

// Parent-side broker: the sandboxed child reaches the ledger, recipe and evidence handlers only through this
// abstract unix socket, authenticated by a per-run token and bound to one scenario and run id.
export async function createLedgerBroker(ledger, scenario, handlers = {}) {
  if (!ledger.configuration.scenarios[scenario]) fail('invalid ledger broker');
  const socketName = `agent-sdlc-canary-${randomUUID()}`;
  const token = randomBytes(32).toString('hex'), active = new Map(), connections = new Set();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let bytes = Buffer.alloc(0), dispatched = false;
    socket.on('data', chunk => {
      if (dispatched) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1048576) { socket.destroy(); return; }
      if (!bytes.includes(10)) return;
      dispatched = true;
      try {
        const message = JSON.parse(bytes.toString('utf8'));
        if (['recipe', 'evidence'].includes(message.method) && handlers[message.method]) {
          if (message.token !== token || message.scenario !== scenario
            || message.request?.runId !== ledger.configuration.scenarios[scenario].runId
            || Object.keys(message).some(key => !['token', 'method', 'request', 'scenario'].includes(key))) {
            fail('invalid broker request');
          }
          socket.setTimeout(0);
          handlers[message.method](message.request).then(
            value => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
            () => socket.end(`${JSON.stringify({ ok: false, error: 'experiment broker request rejected' })}\n`));
          return;
        }
        if (message.token !== token || !['clock', 'reserve', 'settle'].includes(message.method)
          || Object.keys(message).some(key => !['token', 'method', 'request', 'value', 'scenario'].includes(key))) {
          fail('invalid broker request');
        }
        let value;
        if (message.method === 'clock') value = ledger.clock();
        else {
          if (message.scenario !== scenario || message.request?.runId !== ledger.configuration.scenarios[scenario].runId) {
            fail('unbound broker scenario');
          }
          const key = JSON.stringify([message.request.runId, message.request.operationId]);
          if (message.method === 'reserve') {
            ledger.reserve(message.request, scenario, message.value);
            active.set(key, message.request);
          } else {
            if (!active.has(key)) fail('unowned broker settlement');
            ledger.settle(message.request, message.value);
            active.delete(key);
          }
        }
        socket.end(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'experiment broker request rejected' })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\0${socketName}`, resolve);
  });
  return {
    socketName, token,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const request of active.values()) ledger.settle(request, null);
      active.clear();
    },
  };
}

export class RemoteExperimentLedger {
  constructor({ socketName, token, scenario }) {
    if (!/^agent-sdlc-canary-[a-f0-9-]{36}$/.test(socketName) || !/^[a-f0-9]{64}$/.test(token)
      || typeof scenario !== 'string' || !scenario) fail('invalid remote ledger');
    this.socketName = socketName;
    this.token = token;
    this.scenario = scenario;
  }

  recipe(request, timeoutMs) {
    return this.call('recipe', { scenario: this.scenario, request }, { timeoutMs: timeoutMs + 15000, maxBytes: 65536 });
  }

  evidence(request, timeoutMs) {
    return this.call('evidence', { scenario: this.scenario, request }, { timeoutMs: timeoutMs + 15000, maxBytes: 2621440 });
  }

  call(method, fields = {}, { timeoutMs = 5000, maxBytes = 4096 } = {}) {
    return new Promise((resolve, reject) => {
      const request = `${JSON.stringify({ ...fields, method, token: this.token })}\n`;
      if (Buffer.byteLength(request) > 1048576) { reject(Error('broker request too large')); return; }
      const socket = net.createConnection(`\0${this.socketName}`);
      let bytes = Buffer.alloc(0), complete = false;
      socket.setTimeout(timeoutMs, () => socket.destroy(Error('broker timeout')));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(request));
      socket.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > maxBytes) socket.destroy(Error('broker response too large'));
      });
      socket.on('end', () => {
        try {
          const response = JSON.parse(bytes.toString('utf8'));
          if (response.ok !== true) throw Error('experiment broker request rejected');
          complete = true;
          resolve(response.value);
        } catch (error) { reject(error); }
      });
      socket.on('close', () => {
        if (!complete) reject(Error('experiment broker disconnected'));
      });
    });
  }

  // Frozen inventory lookup only; the parent's reserve() enforces exhaustion authoritatively.
  bind(configuration) { this.configuration = configuration; return this; }
  dispatchLimits(request, scenario) {
    const entry = this.configuration?.dispatchInventory?.find(value => value.scenario === scenario
      && value.runId === request?.runId && value.roleId === request?.attribution?.roleId);
    if (!entry) fail('request absent from frozen dispatch inventory');
    return entry;
  }

  clock() { return this.call('clock'); }
  reserve(request, scenario, charge) { return this.call('reserve', { request, scenario, value: charge }); }
  settle(request, actual) {
    return this.call('settle', { request, scenario: this.scenario, value: actual });
  }
}
