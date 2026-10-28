// SPDX-License-Identifier: AGPL-3.0-only
// Build the insights rollups again from run history. Use it after an import or a bug fix.
//   DATABASE_URL=... pnpm run stats:rebuild [organizationId]
import { createDb } from "./client";
import { rebuildStats } from "./stats-maintenance";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}

const handle = createDb(url);
try {
  const organizationId = process.argv[2];
  const { runs, nodes } = await rebuildStats(handle.db, { organizationId });
  console.log(`Rebuilt rollups from ${runs} run(s) and ${nodes} node result(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await handle.close();
}
