// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDb, eq, runMigrations, schema, sql } from "@zerodot/db";
import { createAuth } from "./index";

const url = process.env.DATABASE_URL;

describe("auth", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  const base = { db, baseURL: "http://localhost:3000", secret: "x".repeat(32) };

  before(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await runMigrations(handle);
  });
  after(() => handle.close());

  it("first signup creates a Personal project, user is owner", async () => {
    const auth = createAuth(base);
    const res = await auth.api.signUpEmail({
      body: { email: "a@example.com", password: "password1234", name: "A" },
    });
    const rows = await db
      .select({ name: schema.organization.name, role: schema.member.role })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, res.user.id));
    assert.deepEqual(rows, [{ name: "Personal", role: "owner" }]);
  });

  it("signupDisabled blocks signup without invitation", async () => {
    const auth = createAuth({ ...base, signupDisabled: true });
    await assert.rejects(
      auth.api.signUpEmail({
        body: { email: "b@example.com", password: "password1234", name: "B" },
      }),
    );
  });

  it("signupDisabled can be a function that answers per signup", async () => {
    let disabled = true;
    const auth = createAuth({ ...base, signupDisabled: () => disabled });
    const body = { email: "c@example.com", password: "password1234", name: "C" };
    await assert.rejects(auth.api.signUpEmail({ body }));
    disabled = false;
    await auth.api.signUpEmail({ body });
  });
});
