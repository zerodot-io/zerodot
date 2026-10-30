// SPDX-License-Identifier: AGPL-3.0-only

export type SupplyUseStatus = "running" | "succeeded" | "failed";

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
export function trackUse<T>(value: T, report: (status: SupplyUseStatus) => void, depth = 2): T {
  let open = 0;
  let failed = false;
  const start = () => {
    if (open++ === 0) {
      failed = false;
      report("running");
    }
  };
  const end = (ok: boolean) => {
    if (!ok) failed = true;
    if (--open === 0) report(failed ? "failed" : "succeeded");
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
          let out: unknown;
          try {
            // The method runs on the object itself, so private fields of a class still work.
            out = (member as (...a: unknown[]) => unknown).apply(target, args);
          } catch (error) {
            end(false);
            throw error;
          }
          if (out instanceof Promise) {
            return out.then(
              (result: unknown) => {
                end(true);
                return wrap(result, level - 1);
              },
              (error: unknown) => {
                end(false);
                throw error;
              },
            );
          }
          end(true);
          return wrap(out, level - 1);
        };
      },
    });
  };
  return wrap(value, depth) as T;
}
