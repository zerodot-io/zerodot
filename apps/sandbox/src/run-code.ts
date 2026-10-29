// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CodeLog,
  SANDBOX_LOG_LEVELS,
  SANDBOX_MAX_LOG_CHARS,
  SANDBOX_MAX_LOGS,
  type SandboxRequest,
} from "@zerodot/engine";
import ivm from "isolated-vm";

const MEMORY_LIMIT_MB = 128;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

/** The code failed. The message is safe to show to the user. */
export class CodeError extends Error {
  /** The `console` calls before the failure. */
  logs: CodeLog[] = [];
}

// The wrapper is one line, so line numbers in an error match the code of the user.
const HEADER = '(async function ($input, $trigger, $node, $vars, $run) { "use strict"; ';

/**
 * Run user code in a new V8 isolate. The isolate has no Node API, no network, no timers, and no
 * file access. It only gets the JSON values in `scope`. The values of `$vars` are frozen.
 */
export async function runCode(request: SandboxRequest): Promise<unknown> {
  return (await runCodeWithLogs(request)).result;
}

/** Same as `runCode`. It also gives the `console` calls of the code, also when the code fails. */
export async function runCodeWithLogs(
  request: SandboxRequest,
): Promise<{ result: unknown; logs: CodeLog[] }> {
  const logs: CodeLog[] = [];
  let dropped = 0;
  try {
    const result = await execute(request, (level, message) => {
      if (logs.length >= SANDBOX_MAX_LOGS) {
        dropped++;
        return;
      }
      logs.push({ level, message: message.slice(0, SANDBOX_MAX_LOG_CHARS) });
    });
    return { result, logs: withDropped(logs, dropped) };
  } catch (error) {
    if (error instanceof CodeError) error.logs = withDropped(logs, dropped);
    throw error;
  }
}

function withDropped(logs: CodeLog[], dropped: number): CodeLog[] {
  return dropped > 0 ? [...logs, { level: "warn", message: `${dropped} more logs dropped` }] : logs;
}

async function execute(
  request: SandboxRequest,
  onLog: (level: CodeLog["level"], message: string) => void,
): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });
  // Each Context, Script, and Reference holds a native handle. Release all of them, or they stay
  // in memory until the garbage collector runs.
  const handles: { release(): void }[] = [];
  let timedOut = false;
  // `timeout` stops code that never ends in one step. This timer also stops waiting code.
  const timer = setTimeout(() => {
    timedOut = true;
    if (!isolate.isDisposed) isolate.dispose();
  }, request.timeoutMs + 100);

  try {
    const context = await isolate.createContext();
    handles.push(context);
    await context.global.set("__scope", JSON.stringify(request.scope));
    await context.global.set(
      "__log",
      new ivm.Callback((level: string, message: string) => {
        if ((SANDBOX_LOG_LEVELS as readonly string[]).includes(level)) {
          onLog(level as CodeLog["level"], String(message));
        }
      }),
    );

    const source = `${HEADER}${request.code}\n});`;
    const bootstrap = `
      (async () => {
        const scope = JSON.parse(globalThis.__scope);
        delete globalThis.__scope;
        const sendLog = globalThis.__log;
        delete globalThis.__log;
        const show = (value) => {
          if (typeof value === "string") return value;
          if (value instanceof Error) return value.stack || String(value);
          if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
            return String(value);
          }
          try {
            const text = JSON.stringify(value);
            return text === undefined ? String(value) : text;
          } catch {
            return String(value);
          }
        };
        const write = (level) => (...args) => { sendLog(level, args.map(show).join(" ")); };
        globalThis.console = Object.freeze({
          log: write("log"),
          info: write("info"),
          warn: write("warn"),
          error: write("error"),
          debug: write("debug"),
        });
        const freeze = (value) => {
          if (value && typeof value === "object" && !Object.isFrozen(value)) {
            Object.freeze(value);
            for (const key of Object.keys(value)) freeze(value[key]);
          }
          return value;
        };
        freeze(scope.$vars);
        const user = globalThis.__user;
        delete globalThis.__user;
        const value = await user(scope.$input, scope.$trigger, scope.$node, scope.$vars, scope.$run);
        return JSON.stringify(value);
      })()
    `;

    let userFunction: ivm.Script;
    try {
      userFunction = await isolate.compileScript(source, { filename: "code.js" });
      handles.push(userFunction);
    } catch (error) {
      throw new CodeError(
        `SyntaxError: ${tidy(error instanceof Error ? error.message : String(error))}`,
      );
    }
    const fn = await userFunction.run(context, { reference: true, timeout: request.timeoutMs });
    handles.push(fn);
    await context.global.set("__user", fn.derefInto());
    const script = await isolate.compileScript(bootstrap, { filename: "zerodot-bootstrap.js" });
    handles.push(script);
    const text = (await script.run(context, {
      timeout: request.timeoutMs,
      promise: true,
    })) as string | undefined;

    if (text === undefined) return null;
    const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const size = Buffer.byteLength(text);
    if (size > limit)
      throw new CodeError(`The result is ${size} bytes. The limit is ${limit} bytes`);
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof CodeError) throw error;
    throw new CodeError(describe(error, timedOut, request.timeoutMs));
  } finally {
    clearTimeout(timer);
    for (const handle of handles) {
      try {
        handle.release();
      } catch {
        // The isolate is already gone, so the handle is already free.
      }
    }
    if (!isolate.isDisposed) isolate.dispose();
  }
}

function describe(error: unknown, timedOut: boolean, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (timedOut || /timed out/i.test(message)) return `The code took longer than ${timeoutMs} ms`;
  if (/memory limit/i.test(message)) {
    return `The code used more than ${MEMORY_LIMIT_MB} MB of memory`;
  }
  if (/disposed/i.test(message)) return "The code was stopped";
  // First line only. The stack shows paths of the sandbox, not of the user.
  return tidy(message.split("\n")[0] ?? "The code failed");
}

/** "Unexpected token [code.js:3:10]" becomes "Unexpected token (line 3)". */
function tidy(message: string): string {
  return message.replace(/\s*\[code\.js:(\d+):\d+\]/, " (line $1)").replace(/^Error: /, "");
}
