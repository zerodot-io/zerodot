// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Nodes that touch the machine of the worker are off by default. The operator turns them on
 * with environment variables, because everybody who can edit a workflow can use them.
 */

export const COMMANDS_ENV = "ZERODOT_ENABLE_EXECUTE_COMMAND";
export const FILES_ENV = "ZERODOT_FILES_DIR";

export function assertCommandsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[COMMANDS_ENV] !== "true") {
    throw new Error(`Execute Command is off. The operator sets ${COMMANDS_ENV}=true to turn it on`);
  }
}

/**
 * The absolute path of a file inside the folder in ZERODOT_FILES_DIR. A path that leaves the
 * folder (`..` or a symbolic link) is refused.
 */
export async function resolveFilePath(
  requested: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const dir = env[FILES_ENV];
  if (!dir) {
    throw new Error(`File access is off. The operator sets ${FILES_ENV} to a folder to turn it on`);
  }
  const { realpath } = await import("node:fs/promises");
  const { dirname, resolve, sep } = await import("node:path");
  const root = await realpath(resolve(dir));
  const target = resolve(root, requested);
  // The file may not exist yet. Check the nearest folder that exists.
  let existing = target;
  for (;;) {
    try {
      const real = await realpath(existing);
      const inside = real === root || real.startsWith(root + sep);
      if (!inside) throw new Error("The path is outside the allowed folder");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error("The path is outside the allowed folder");
      existing = parent;
    }
  }
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("The path is outside the allowed folder");
  }
  return target;
}
