import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PID_DIR = join(homedir(), '.cmux-relay');
const DEFAULT_PID_FILE = join(DEFAULT_PID_DIR, 'agent.pid');

/**
 * Kill stale cmux-relay processes found via pgrep.
 */
function killStaleProcesses(): void {
  try {
    const out = execFileSync(
      'pgrep', ['-f', 'cmux-relay.*(tsx|src/index)'],
      { encoding: 'utf-8' }
    ).trim();
    if (!out) return;

    const pids = out.split('\n').map(Number).filter(p => p && p !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Killed stale process PID ${pid}`);
      } catch {
        // Already dead
      }
    }
  } catch {
    // pgrep not available or no matches
  }

  try {
    execFileSync('pkill', ['-f', 'cat /var/folders.*cmux-relay'], { stdio: 'ignore' });
  } catch {
    // Ignore
  }
}

/**
 * Ensure only one instance of cmux-relay agent is running.
 * Kills stale processes, then manages PID file to enforce single instance.
 */
export async function ensureSingleInstance(pidFile: string = DEFAULT_PID_FILE): Promise<string> {
  killStaleProcesses();

  if (!existsSync(pidFile)) {
    await writeFile(pidFile, `${process.pid}`);
    return pidFile;
  }

  const existingPid = parseInt(await readFile(pidFile, 'utf-8'), 10);
  if (isNaN(existingPid)) {
    await writeFile(pidFile, `${process.pid}`);
    return pidFile;
  }

  try {
    process.kill(existingPid, 0);
  } catch {
    await writeFile(pidFile, `${process.pid}`);
    return pidFile;
  }

  console.log(`Stopping existing instance (PID ${existingPid})...`);
  process.kill(existingPid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 2000));

  try {
    process.kill(existingPid, 0);
    console.log(`Force killing PID ${existingPid}...`);
    process.kill(existingPid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 500));
  } catch {
    // Good, it stopped
  }

  await writeFile(pidFile, `${process.pid}`);
  return pidFile;
}

/**
 * Remove the PID file on clean shutdown.
 */
export async function cleanupPidFile(pidFile: string): Promise<void> {
  try {
    await unlink(pidFile);
  } catch {
    // Ignore
  }
}
