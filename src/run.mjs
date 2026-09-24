// A tiny wrapper around child_process.spawn that captures output and
// NEVER throws / rejects on a non-zero exit or a missing binary. Callers
// inspect { code, stdout, stderr, error } and decide what to do.
import { spawn } from 'node:child_process';

/**
 * Run a command, resolving with its captured output.
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{ input?: string, timeout?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, error?: Error }>}
 */
export function run(cmd, args = [], options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let timer = null;
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        done({ code: -1, stdout, stderr, error: new Error(`timed out after ${options.timeout}ms`) });
      }, options.timeout);
    }

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr || String(error), error });
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ code: code == null ? -1 : code, stdout, stderr });
    });

    if (options.input != null && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}
