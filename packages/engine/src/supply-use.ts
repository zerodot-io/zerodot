// SPDX-License-Identifier: AGPL-3.0-only

export type SupplyUseStatus = "running" | "succeeded" | "failed";

/** One call of a supply value that ended: what went in and what came out, as plain data. */
export type SupplyCall = {
  method: string;
  input: unknown;
  output?: unknown;
  error?: { message: string };
};

/** A copy with no functions, signals, or cycles, so it can go in a run event. */
function plain(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function" || value instanceof AbortSignal) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => plain(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const copy = plain(item, seen);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}

/** The arguments of a call as input: one argument as it is, more as a list. Signals are left out. */
function inputOf(args: unknown[]): unknown {
  const kept = args.filter((arg) => typeof arg !== "function" && !(arg instanceof AbortSignal));
  return plain(kept.length === 1 ? kept[0] : kept);
}

/** True when an object has methods, its own or from its class. Plain data has none. */
function hasMethods(value: object): boolean {
  if (Object.values(value).some((item) => typeof item === "function")) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype || typeof proto !== "object") return false;
  return Object.getOwnPropertyNames(proto).some(
    (key) => key !== "constructor" && typeof (value as Record<string, unknown>)[key] === "function",
  );
}

/**
 * A view of a supply value that reports each call of its methods: "running" when the first call
 * starts, and "succeeded" or "failed" when the last open call ends. What a method returns is
 * tracked too, `depth` levels down, so the tools that a tool set opens report as well. Plain
 * data is given back as it is, so it can still be copied or stored.
 */
export function trackUse<T>(
  value: T,
  report: (status: SupplyUseStatus, call?: SupplyCall) => void,
  depth = 2,
): T {
  let open = 0;
  let failed = false;
  const start = () => {
    if (open++ === 0) {
      failed = false;
      report("running");
    }
  };
  /** Each ended call is reported with its data. The status stays "running" while calls are open. */
  const end = (ok: boolean, call: SupplyCall) => {
    if (!ok) failed = true;
    open--;
    report(open > 0 ? "running" : failed ? "failed" : "succeeded", call);
  };
  const wrap = (item: unknown, level: number): unknown => {
    if (level < 0 || item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map((entry) => wrap(entry, level));
    if (!hasMethods(item)) return item;
    return new Proxy(item, {
      get(target, key) {
        const member: unknown = Reflect.get(target, key, target);
        if (typeof member !== "function" || typeof key === "symbol") return member;
        return (...args: unknown[]) => {
          start();
          const method = key;
          const input = inputOf(args);
          const failure = (error: unknown) => ({
            method,
            input,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
          let out: unknown;
          try {
            // The method runs on the object itself, so private fields of a class still work.
            out = (member as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            end(false, failure(error));
            throw error;
          }
          if (out instanceof Promise) {
            return out.then(
              (result: unknown) => {
                end(true, { method, input, output: plain(result) });
                return wrap(result, level - 1);
              },
              (error: unknown) => {
                end(false, failure(error));
                throw error;
              },
            );
          }
          end(true, { method, input, output: plain(out) });
          return wrap(out, level - 1);
        };
      },
    });
  };
  return wrap(value, depth) as T;
}
