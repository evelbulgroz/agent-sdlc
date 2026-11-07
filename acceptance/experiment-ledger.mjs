import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bytesHash, fail } from './primitives.mjs';
import { DIMENSIONS, freezeConfiguration, validateExperimentConfiguration } from './experiment-budget.mjs';

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return { pid, started: fields[19],
      namespace: fs.readlinkSync(`/proc/${pid}/ns/pid`),
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

function ownerAlive(value) {
  if (!value) fail('reservation owner unknown; operator reconciliation required');
  const owner = JSON.parse(value);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.started
    || !owner.namespace || !owner.boot) fail('invalid reservation owner');
  const current = processIdentity(process.pid);
  if (owner.boot !== current.boot) return false;
  if (owner.namespace !== current.namespace) fail('reservation owner namespace cannot be inspected');
  const actual = processIdentity(owner.pid);
  return actual !== null && actual.started === owner.started;
}

export class ExperimentLedger {
  constructor(file, configuration, { now = Date.now } = {}) {
    validateExperimentConfiguration(configuration);
    this.now = now;
    // Only live process time is charged; idle gaps between operator commands (human waits) are free.
    this.mark = now();
    this.configuration = freezeConfiguration(structuredClone(configuration));
    this.owner = JSON.stringify({ ...processIdentity(process.pid), token: randomUUID() });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS experiment (id INTEGER PRIMARY KEY CHECK(id=1),
        configuration_hash TEXT NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL,
        last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (run_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        scenario TEXT NOT NULL, role_id TEXT, request_hash TEXT NOT NULL, state TEXT NOT NULL, charge TEXT NOT NULL,
        owner TEXT,
        PRIMARY KEY(run_id, operation_id));`);
    for (const [table, column, definition] of [['reservations', 'owner', 'TEXT'], ['reservations', 'role_id', 'TEXT'],
      ['experiment', 'active_ms', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
  }

  // Charges live process time since the last check, so a blocked or killed child is not free.
  accrue() {
    const now = this.now();
    this.db.prepare('UPDATE experiment SET active_ms=active_ms+?, last_seen=MAX(last_seen, ?) WHERE id=1')
      .run(Math.max(0, now - this.mark), now);
    this.mark = now;
  }

  close() { this.accrue(); this.db.close(); }

  dispatchLimits(request, scenario) {
    const roleId = request?.attribution?.roleId;
    const entry = this.configuration.dispatchInventory.find(value => value.scenario === scenario
      && value.runId === request?.runId && value.roleId === roleId);
    if (!entry) fail('request absent from frozen dispatch inventory');
    if (this.db.prepare('SELECT 1 FROM reservations WHERE role_id IS NULL LIMIT 1').get()) {
      fail('legacy reservation history has no dispatch identity');
    }
    const used = this.db.prepare(`SELECT COUNT(*) AS count FROM reservations
      WHERE scenario=? AND run_id=? AND role_id=?`).get(scenario, request.runId, roleId).count;
    if (used >= entry.logicalCalls) fail('dispatch inventory exhausted');
    return entry;
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = action();
      this.db.exec('COMMIT');
      this.inTransaction = false;
      if (this.pendingMark !== undefined) this.mark = this.pendingMark;
      this.pendingMark = undefined;
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.inTransaction = false;
      this.pendingMark = undefined;
      this.db.prepare('UPDATE experiment SET last_seen=MAX(last_seen, ?) WHERE id=1').run(this.now());
      throw error;
    }
  }

  begin() {
    return this.transaction(() => {
      const hash = bytesHash(Buffer.from(JSON.stringify(this.configuration)));
      const row = this.db.prepare('SELECT * FROM experiment WHERE id=1').get();
      if (row && row.configuration_hash !== hash) fail('experiment configuration changed');
      if (!row) {
        const now = this.now();
        this.db.prepare('INSERT INTO experiment (id, configuration_hash, started, deadline, last_seen) VALUES (1, ?, ?, ?, ?)')
          .run(hash, now, now + this.configuration.maxElapsedMs, now);
      }
      return this.clock();
    });
  }

  clock() {
    const row = this.db.prepare('SELECT * FROM experiment WHERE id=1').get();
    const now = this.now();
    if (row) this.db.prepare('UPDATE experiment SET last_seen=MAX(last_seen, ?) WHERE id=1').run(now);
    if (!row || now < row.last_seen) fail('experiment deadline/clock violation');
    const active = row.active_ms + Math.max(0, now - this.mark);
    if (active >= this.configuration.maxElapsedMs) fail('experiment deadline/clock violation');
    const deadline = now + this.configuration.maxElapsedMs - active;
    this.db.prepare('UPDATE experiment SET active_ms=?, deadline=? WHERE id=1').run(active, deadline);
    if (this.inTransaction) this.pendingMark = now;
    else this.mark = now;
    return { startsAt: row.started, deadline };
  }

  reserve(request, scenario, charge) {
    for (const key of DIMENSIONS) {
      if (!Number.isSafeInteger(charge[key]) || charge[key] < 0) fail(`invalid reservation ${key}`);
    }
    return this.transaction(() => {
      this.clock();
      const allocation = this.configuration.scenarios[scenario];
      if (!allocation || allocation.runId !== request?.runId || charge.logicalCalls !== 1) {
        fail('unbound scenario/run or logical dispatch');
      }
      const hash = bytesHash(Buffer.from(JSON.stringify(request)));
      const existing = this.db.prepare('SELECT * FROM reservations WHERE run_id=? AND operation_id=?')
        .get(request.runId, request.operationId);
      if (existing) {
        if (existing.request_hash !== hash) fail('operation input drift');
        // Never repeat an uncertain provider operation merely because its owner died.
        fail('operation already charged; reconcile through the operator');
      }
      const dispatch = this.dispatchLimits(request, scenario);
      if (charge.physicalCalls > dispatch.maxPhysicalAttempts
        || charge.inputTokens > charge.physicalCalls * dispatch.maxPromptTokens
        || charge.outputTokens > charge.physicalCalls * dispatch.maxCompletionTokens
        || charge.costMicrousd > charge.physicalCalls * this.configuration.maxAttemptCostMicrousd) {
        fail('reservation exceeds frozen dispatch limits');
      }
      if (this.db.prepare("SELECT 1 FROM reservations WHERE state='active'").get()) {
        fail('experiment concurrency exceeded');
      }
      const rows = this.db.prepare('SELECT scenario, charge FROM reservations').all();
      for (const [name, limits] of [['shared', this.configuration], [scenario, allocation]]) {
        const selected = rows.filter((row) => name === 'shared' || row.scenario === scenario);
        for (const key of DIMENSIONS) {
          const used = selected.reduce((total, row) => total + JSON.parse(row.charge)[key], 0);
          if (!Number.isSafeInteger(limits[key]) || used + charge[key] > limits[key]) {
            fail(`${name} ${key} exhausted`);
          }
        }
      }
      this.db.prepare(`INSERT INTO reservations
        (run_id, operation_id, scenario, role_id, request_hash, state, charge, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(request.runId, request.operationId, scenario, request.attribution.roleId,
          hash, 'active', JSON.stringify(charge), this.owner);
    });
  }

  settle(request, actual = null) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM reservations WHERE run_id=? AND operation_id=?')
        .get(request.runId, request.operationId);
      if (!row || row.state !== 'active') fail('missing active reservation');
      if (row.owner !== this.owner) fail('reservation belongs to another owner');
      const reserved = JSON.parse(row.charge);
      if (actual && DIMENSIONS.some((key) => !Number.isSafeInteger(actual[key])
        || actual[key] < 0 || actual[key] > reserved[key])) fail('usage exceeds frozen reservation');
      this.db.prepare('UPDATE reservations SET state=?, charge=? WHERE run_id=? AND operation_id=?')
        .run(actual ? 'settled' : 'uncertain', JSON.stringify(actual ?? reserved),
          request.runId, request.operationId);
    });
  }

  recover() {
    return this.transaction(() => {
      this.clock();
      const active = this.db.prepare("SELECT owner FROM reservations WHERE state='active'").all();
      if (active.some((row) => ownerAlive(row.owner))) fail('live reservation owner; recovery forbidden');
      this.db.prepare("UPDATE reservations SET state='uncertain' WHERE state='active'").run();
    });
  }
}
