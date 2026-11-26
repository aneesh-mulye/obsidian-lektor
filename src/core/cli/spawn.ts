// SPDX-FileCopyrightText: 2026 Aneesh Mulye
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Starting a CLI process (INVARIANTS.md L3, L5): an argument array, never a
 * shell; stdout as lines, a capped stderr, and a kill that escalates. This is
 * the only module that imports `child_process`.
 */

import { spawn } from 'node:child_process';

export interface SpawnOptions {
  cwd: string;
  /** Extra environment variables, on top of Obsidian's. */
  env?: Record<string, string>;
}

export interface Spawned {
  /** stdout, line by line (without the newline). Ends when the process closes stdout. */
  readonly lines: AsyncIterable<string>;
  /** The last 8 KB of stderr. */
  stderr(): string;
  /** Resolves when the process has exited. */
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  write(data: string): void;
  end(): void;
  /** SIGTERM, then SIGKILL after 3 s. */
  kill(): void;
}

export interface Spawner {
  run(command: string, args: readonly string[], options: SpawnOptions): Spawned;
}

export const nodeSpawner: Spawner = {
  run(command, args, options) {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-8192);
    });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', (err) => {
        stderr = (stderr + String(err.message)).slice(-8192);
        resolve({ code: -1, signal: null });
      });
    });
    child.stdin.on('error', () => undefined); // a process that exits early closes its stdin
    const lines = (async function* () {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          yield buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer !== '') yield buffer;
    })();
    return {
      lines,
      stderr: () => stderr,
      exit,
      write: (data) => {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      end: () => {
        if (!child.stdin.destroyed) child.stdin.end();
      },
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const t = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3000);
        void exit.then(() => clearTimeout(t));
      },
    };
  },
};
