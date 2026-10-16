import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { LoopbackDevice, IpcChannel } from '../shared/types';

/** Resolve the path to the bundled WASAPI helper, checking dev + prod locations. */
export function resolveHelperPath(): string {
  const candidates = [
    // dev: alongside project root
    path.resolve(app.getAppPath(), '..', 'loopback-build', 'faze-loopback.exe'),
    // dev: inside project root (alt)
    path.resolve(app.getAppPath(), 'loopback-build', 'faze-loopback.exe'),
    // packaged: under resources
    path.resolve(process.resourcesPath ?? '', 'loopback-build', 'faze-loopback.exe'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error('faze-loopback.exe not found (looked in dev + resources paths)');
}

/** Enumerate render endpoints. Backend script returns JSON array to stdout. */
export async function listLoopbackDevices(): Promise<LoopbackDevice[]> {
  const exe = resolveHelperPath();
  return await new Promise<LoopbackDevice[]>((resolve, reject) => {
    const child = spawn(exe, ['list'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`helper exited with code ${code}: ${Buffer.concat(err).toString('utf8')}`));
      }
      try {
        const json = Buffer.concat(out).toString('utf8').trim();
        const list: LoopbackDevice[] = JSON.parse(json);
        resolve(list);
      } catch (e) {
        reject(new Error(`couldn't parse helper output: ${(e as Error).message}`));
      }
    });
    child.on('error', reject);
  });
}

/**
 * Wraps the spawned helper for a single loopback capture session.
 * Emits Float32 (interleaved stereo, 48000Hz Float32LE) chunks via the
 * 'samples' event.
 */
export class LoopbackSession extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = Buffer.alloc(0);
  readonly device: LoopbackDevice;

  constructor(device: LoopbackDevice) {
    super();
    this.device = device;
  }

  start(sampleRate = 48000): void {
    if (this.proc) return;
    const exe = resolveHelperPath();
    this.proc = spawn(exe, ['capture', this.device.id, String(sampleRate)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => this.emit('error', err));

    this.proc.stderr?.on('data', (c: Buffer) => {
      // Forward helper stderr as informational messages.
      const msg = c.toString('utf8').trim();
      if (msg) this.emit('log', msg);
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      const merged = Buffer.concat([this.buf, chunk]);
      const aligned = merged.length - (merged.length % 4);
      if (aligned > 0) {
        const len = aligned / 4;
        // Hand out a *copy* so the ArrayBuffer doesn't get clobbered by the
        // next Buffer.concat iteration over the same backing store.
        const floats = new Float32Array(len);
        const view = new Float32Array(merged.buffer, merged.byteOffset, len);
        floats.set(view);
        this.emit('samples', floats);
        this.buf = merged.subarray(aligned);
      } else {
        this.buf = merged;
      }
    });

    this.proc.on('close', (code, signal) => {
      this.emit('close', { code, signal });
      this.proc = null;
    });
  }

  /** Stops the helper (closes stdin -> triggers clean shutdown). */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    try { proc.stdin?.end(); } catch { /* noop */ }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.once('close', finish);
      // Belt-and-suspenders timeout — if the helper ignores stdin EOF, kill it.
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch {} }, 1500);
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; finish(); }, 3000);
    });
    this.proc = null;
  }
}

/** Singleton manager shared by main process — only one session at a time. */
class LoopbackManager {
  private current: LoopbackSession | null = null;

  active(): LoopbackSession | null {
    return this.current;
  }

  async start(device: LoopbackDevice, sampleRate: number, getWindow: () => BrowserWindow | null): Promise<void> {
    await this.stop();
    const session = new LoopbackSession(device);
    this.current = session;

    const broadcast = (channel: string, payload: unknown) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };

    session.on('samples', (floats: Float32Array) => {
      // Convert to a Buffer-backed Uint8Array so Electron serialises it
      // efficiently across IPC.
      const u8 = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
      broadcast(IpcChannel.loopbackSamples, u8);
    });

    session.on('log', (msg: string) => {
      // Re-emit a small subset of stderr so the renderer HUD can show it.
      if (msg.includes('error') || msg.includes('Error')) {
        broadcast(IpcChannel.loopbackEvent, { type: 'error', message: msg });
      }
    });

    session.on('close', () => {
      broadcast(IpcChannel.loopbackEvent, { type: 'stopped' });
      if (this.current === session) this.current = null;
    });

    session.start(sampleRate);
    broadcast(IpcChannel.loopbackEvent, { type: 'started', deviceId: device.id, deviceName: device.name });
  }

  async stop(): Promise<void> {
    if (this.current) {
      const s = this.current;
      this.current = null;
      await s.stop();
    }
  }
}

export const loopbackManager = new LoopbackManager();
