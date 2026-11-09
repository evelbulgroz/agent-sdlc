import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fail } from './primitives.ts';
import type { ExperimentLedger } from './experiment-ledger.ts';
import type {
  DimensionAmounts, DispatchInventoryEntry, DispatchRequest, EvidenceBrokerRequest, EvidenceBrokerResult,
  ExperimentClock, ExperimentConfiguration, ExperimentLedgerPort, RecipeBrokerRequest, RecipeBrokerResult,
} from './experiment-types.ts';

export interface BrokerHandlers {
  recipe?: (request: RecipeBrokerRequest) => Promise<RecipeBrokerResult>;
  evidence?: (request: EvidenceBrokerRequest) => Promise<EvidenceBrokerResult>;
}

type BrokerMethod = 'recipe' | 'evidence' | 'clock' | 'reserve' | 'settle';
type BrokerRequest = DispatchRequest & RecipeBrokerRequest & EvidenceBrokerRequest;

// Untrusted wire message; every field is validated before use.
interface BrokerMessage {
  token?: unknown;
  method?: BrokerMethod;
  scenario?: unknown;
  request?: BrokerRequest;
  value?: DimensionAmounts;
}

export interface LedgerBroker { socketName: string; token: string; close(): Promise<void> }

// Parent-side broker: the sandboxed child reaches the ledger, recipe and evidence handlers only through this
// abstract unix socket, authenticated by a per-run token and bound to one scenario and run id.
export async function createLedgerBroker(ledger: ExperimentLedger, scenario: string, handlers: BrokerHandlers = {}): Promise<LedgerBroker> {
  if (!ledger.configuration.scenarios[scenario]) fail('invalid ledger broker');
  const socketName = `agent-sdlc-canary-${randomUUID()}`;
  const token = randomBytes(32).toString('hex'), active = new Map<string, DispatchRequest>(), connections = new Set<net.Socket>();
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
        const message: BrokerMessage = JSON.parse(bytes.toString('utf8'));
        if (message.method === 'recipe' || message.method === 'evidence') {
          const handler = message.method === 'recipe' ? handlers.recipe : handlers.evidence;
          if (!handler) fail('invalid broker request');
          if (message.token !== token || message.scenario !== scenario
            || message.request?.runId !== ledger.configuration.scenarios[scenario].runId
            || Object.keys(message).some(key => !['token', 'method', 'request', 'scenario'].includes(key))) {
            fail('invalid broker request');
          }
          socket.setTimeout(0);
          handler(message.request as BrokerRequest).then(
            value => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
            () => socket.end(`${JSON.stringify({ ok: false, error: 'experiment broker request rejected' })}\n`));
          return;
        }
        if (message.token !== token || !message.method || !['clock', 'reserve', 'settle'].includes(message.method)
          || Object.keys(message).some(key => !['token', 'method', 'request', 'value', 'scenario'].includes(key))) {
          fail('invalid broker request');
        }
        let value: ExperimentClock | undefined;
        if (message.method === 'clock') value = ledger.clock();
        else {
          if (message.scenario !== scenario || !message.request
            || message.request.runId !== ledger.configuration.scenarios[scenario].runId) {
            fail('unbound broker scenario');
          }
          const key = JSON.stringify([message.request.runId, message.request.operationId]);
          if (message.method === 'reserve') {
            if (!message.value) fail('invalid broker request');
            ledger.reserve(message.request, scenario, message.value);
            active.set(key, message.request);
          } else {
            if (!active.has(key)) fail('unowned broker settlement');
            ledger.settle(message.request, message.value ?? null);
            active.delete(key);
          }
        }
        socket.end(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
      } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'experiment broker request rejected' })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\0${socketName}`, () => resolve());
  });
  return {
    socketName, token,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const request of active.values()) ledger.settle(request, null);
      active.clear();
    },
  };
}

export class RemoteExperimentLedger implements ExperimentLedgerPort {
  socketName: string;
  token: string;
  scenario: string;
  configuration: ExperimentConfiguration | undefined;

  constructor({ socketName, token, scenario }: { socketName: string | undefined; token: string | undefined; scenario: string | undefined }) {
    if (typeof socketName !== 'string' || !/^agent-sdlc-canary-[a-f0-9-]{36}$/.test(socketName)
      || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || typeof scenario !== 'string' || !scenario) fail('invalid remote ledger');
    this.socketName = socketName;
    this.token = token;
    this.scenario = scenario;
  }

  recipe(request: RecipeBrokerRequest, timeoutMs: number): Promise<RecipeBrokerResult> {
    return this.call('recipe', { scenario: this.scenario, request }, { timeoutMs: timeoutMs + 15000, maxBytes: 65536 });
  }

  evidence(request: EvidenceBrokerRequest, timeoutMs: number): Promise<EvidenceBrokerResult> {
    return this.call('evidence', { scenario: this.scenario, request }, { timeoutMs: timeoutMs + 15000, maxBytes: 2621440 });
  }

  call<T = unknown>(method: BrokerMethod, fields: Record<string, unknown> = {},
    { timeoutMs = 5000, maxBytes = 4096 }: { timeoutMs?: number; maxBytes?: number } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
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
  bind(configuration: ExperimentConfiguration) { this.configuration = configuration; return this; }
  dispatchLimits(request: DispatchRequest, scenario: string): DispatchInventoryEntry {
    const entry = this.configuration?.dispatchInventory?.find(value => value.scenario === scenario
      && value.runId === request?.runId && value.roleId === request?.attribution?.roleId);
    if (!entry) fail('request absent from frozen dispatch inventory');
    return entry;
  }

  clock(): Promise<ExperimentClock> { return this.call('clock'); }
  reserve(request: DispatchRequest, scenario: string, charge: DimensionAmounts) { return this.call('reserve', { request, scenario, value: charge }); }
  settle(request: DispatchRequest, actual: DimensionAmounts | null) {
    return this.call('settle', { request, scenario: this.scenario, value: actual });
  }
}
