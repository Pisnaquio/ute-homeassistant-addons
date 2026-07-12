'use strict';

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { logEvent, redact } = require('./safe_log');

class SyncManager {
  constructor(options) {
    this.cwd = options.cwd;
    this.statePath = options.statePath;
    this.current = this.readState();
    if (this.current.status === 'running' || this.current.status === 'queued') {
      this.current = this.persist({
        ...this.current,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
        error: { code: 'INTERRUPTED', message: 'La sincronización se interrumpió al reiniciar el add-on.' },
      });
    }
  }

  empty() {
    return { status: 'idle', id: null, kind: null, stage: null, startedAt: null, finishedAt: null, error: null, exitCode: null };
  }

  readState() {
    try {
      const value = fs.readJsonSync(this.statePath);
      return { ...this.empty(), ...value };
    } catch {
      return this.empty();
    }
  }

  persist(next) {
    fs.ensureDirSync(path.dirname(this.statePath));
    const tmp = `${this.statePath}.tmp`;
    fs.writeJsonSync(tmp, next, { spaces: 2 });
    fs.renameSync(tmp, this.statePath);
    this.current = next;
    return this.getStatus();
  }

  getStatus() {
    return { ...this.current };
  }

  isRunning() {
    return this.current.status === 'queued' || this.current.status === 'running';
  }

  start(kind, args, env = process.env) {
    if (this.isRunning()) return null;
    const id = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.persist({ ...this.empty(), id, kind, status: 'queued', stage: 'starting', startedAt: new Date().toISOString() });
    logEvent('info', 'sync.accepted', { job_id: id, kind });

    const child = spawn('node', ['ute_monitor.js', ...args], {
      cwd: this.cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.persist({ ...this.current, status: 'running', stage: 'portal' });

    const forward = (level, chunk) => {
      const message = redact(chunk.toString('utf8')).trim();
      if (!message) return;
      logEvent(level, 'sync.output', { job_id: id, kind, message: message.slice(0, 1000) });
    };
    child.stdout.on('data', chunk => forward('info', chunk));
    child.stderr.on('data', chunk => forward('warn', chunk));
    child.once('error', error => {
      this.persist({ ...this.current, status: 'failed', stage: 'failed', finishedAt: new Date().toISOString(), exitCode: null, error: { code: 'SPAWN_FAILED', message: redact(error.message) } });
      logEvent('error', 'sync.failed', { job_id: id, kind, code: 'SPAWN_FAILED' });
    });
    child.once('exit', code => {
      const succeeded = code === 0;
      this.persist({
        ...this.current,
        status: succeeded ? 'succeeded' : 'failed',
        stage: succeeded ? 'completed' : 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: code,
        error: succeeded ? null : { code: 'SYNC_FAILED', message: 'La sincronización no se pudo completar. Revisá los logs o el diagnóstico.' },
      });
      logEvent(succeeded ? 'info' : 'error', succeeded ? 'sync.succeeded' : 'sync.failed', { job_id: id, kind, exit_code: code });
    });
    return this.getStatus();
  }
}

module.exports = { SyncManager };
