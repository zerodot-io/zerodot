// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createDb,
  findRunAnyOrganization,
  firstUserId,
  forOrganization,
  listAudit,
  recordAudit,
  schema,
} from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;

describe("admin audit", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  const actor = { id: "u1", email: "a@example.com" };

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
  });
  after(() => handle.close());

  it("lists rows newest first and applies the limit", async () => {
    for (let i = 0; i < 3; i++) {
      await recordAudit(db, {
        actor,
        action: `a${i}`,
        targetType: "queue",
        targetId: "zerodot-runs",
        details: { count: i },
      });
    }
    const rows = await listAudit(db, 2);
    assert.deepEqual(
      rows.map((r) => r.action),
      ["a2", "a1"],
    );
    assert.deepEqual(rows[0]?.details, { count: 2 });
    assert.equal(rows[0]?.actorEmail, "a@example.com");
  });

  it("finds the first user and a run in any project", async () => {
    assert.equal(await firstUserId(db), null);
    const now = new Date();
    await db.insert(schema.user).values([
      { id: "late", name: "L", email: "l@example.com", createdAt: new Date(now.getTime() + 1000) },
      { id: "early", name: "E", email: "e@example.com", createdAt: now },
    ]);
    assert.equal(await firstUserId(db), "early");

    const wf = await forOrganization(db, "o1").workflows.create({ name: "W" });
    const [row] = await db
      .insert(schema.run)
      .values({
        organizationId: "o1",
        workflowId: wf.id,
        mode: "production",
        triggerType: "manual",
      })
      .returning();
    assert.ok(row);
    const found = await findRunAnyOrganization(db, row.id);
    assert.equal(found?.organizationId, "o1");
    assert.equal(found?.status, "queued");
    assert.equal(await findRunAnyOrganization(db, "00000000-0000-4000-8000-000000000000"), null);
  });
});
