/**
 * Integration test for sync.mjs against two SCRATCH databases (never real ones):
 *
 *   TEST_SYNC_CLOUD_URL=postgresql://syncer@127.0.0.1:55432/sync_test_cloud \
 *   TEST_SYNC_ARCH_URL=postgresql://syncer@127.0.0.1:55432/sync_test_arch \
 *   TEST_SYNC_APP_ROLE=app_user node --test deploy/arch/sync/sync.test.mjs
 *
 * `syncer` mirrors the hosted `postgres` role: not a superuser, owns the tables,
 * and may `SET session_replication_role`. App writes are made as TEST_SYNC_APP_ROLE
 * (DML only, no rights on `_sync`), like GoTrue / PostgREST would.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { bootstrap, close, createContext, tick } from "./sync.mjs";

const CLOUD = process.env.TEST_SYNC_CLOUD_URL;
const ARCH = process.env.TEST_SYNC_ARCH_URL;
const APP_ROLE = process.env.TEST_SYNC_APP_ROLE ?? "app_user";
if (!/sync_test/.test(CLOUD ?? "") || !/sync_test/.test(ARCH ?? "")) {
  throw new Error("TEST_SYNC_*_URL must point at scratch databases named *sync_test*");
}

const SCHEMA = `
drop schema if exists _sync cascade;
drop table if exists child, parent, multi, gen, uniq, typed, origin_effects, broadcasts, nopk, only_cloud cascade;
create table parent (id uuid primary key default gen_random_uuid(), name text not null);
create table child (id uuid primary key default gen_random_uuid(),
                    parent_id uuid references parent(id) on delete cascade, n int);
create table multi (a int, b text, v text, primary key (a, b));
create table gen (id int primary key, x int, y int generated always as (x * 2) stored);
create table uniq (id int primary key, email text unique);
create table typed (id int primary key, amount numeric(14,2), tags text[], meta jsonb, at timestamptz);
create table origin_effects (id bigserial primary key, src text);
create table broadcasts (n int);   -- no PK: never synced; counts broadcast-trigger runs
create table nopk (n int);
create or replace function parent_side_effect() returns trigger language plpgsql as $$
begin insert into origin_effects (src) values (new.name); return new; end $$;
create trigger trg_parent_side after insert on parent for each row execute function parent_side_effect();
create or replace function fake_broadcast() returns trigger language plpgsql as $$
begin /* stands in for realtime.send(...) */ insert into broadcasts values (1); return null; end $$;
create trigger trg_parent_broadcast after insert or update on parent
  for each row execute function fake_broadcast();
grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
grant usage on all sequences in schema public to ${APP_ROLE};
`;

let ctx;
const sql = {};
const app = {};

async function q(db, text, params) {
  return (await db.query(text, params)).rows;
}
async function settle() {
  for (let i = 0; i < 5; i++) if ((await tick(ctx)) === 0) return;
  throw new Error("sync did not settle");
}
const asApp = (u) => u.replace("://syncer@", `://${APP_ROLE}@`);

before(async () => {
  for (const [name, url] of [["cloud", CLOUD], ["arch", ARCH]]) {
    sql[name] = new pg.Client({ connectionString: url });
    app[name] = new pg.Client({ connectionString: asApp(url) });
    await sql[name].connect();
    await app[name].connect();
    await sql[name].query(SCHEMA);
  }
  await sql.cloud.query("create table only_cloud (id int primary key)");
  // online already has data; arch has junk that bootstrap must replace
  await app.cloud.query("insert into parent (name) values ('p1'), ('p2')");
  await app.cloud.query("insert into multi values (1, 'x', 'one')");
  await app.arch.query("insert into parent (name) values ('arch-junk')");
  await app.arch.query("insert into uniq values (99, 'junk@arch')");

  ctx = createContext({ archUrl: ARCH, cloudUrl: CLOUD, cloudSsl: false });
  await bootstrap(ctx);
});

after(async () => {
  await close(ctx);
  for (const db of [...Object.values(sql), ...Object.values(app)]) await db.end();
});

const rows = (db, t, order = "1") => q(db, `select * from ${t} order by ${order}`);

test("bootstrap makes arch a copy of online and offsets sequences", async () => {
  assert.deepEqual(await rows(sql.arch, "parent", "name"), await rows(sql.cloud, "parent", "name"));
  assert.deepEqual(await rows(sql.arch, "multi"), await rows(sql.cloud, "multi"));
  assert.deepEqual(await rows(sql.arch, "uniq"), []);
  const [{ v: archSeq }] = await q(sql.arch, "select last_value as v from origin_effects_id_seq");
  assert.ok(Number(archSeq) >= 500_000, `arch sequence offset, got ${archSeq}`);
});

test("insert on online reaches arch without re-running side effects", async () => {
  const before = (await q(sql.arch, "select count(*)::int as n from broadcasts"))[0].n;
  await app.cloud.query("insert into parent (name) values ('fresh')");
  await settle();
  assert.equal((await q(sql.arch, "select count(*)::int as n from parent where name = 'fresh'"))[0].n, 1);
  // the side-effect row comes over once (synced), not twice (re-run on arch)
  assert.equal((await q(sql.arch, "select count(*)::int as n from origin_effects where src = 'fresh'"))[0].n, 1);
  assert.equal((await q(sql.cloud, "select count(*)::int as n from origin_effects where src = 'fresh'"))[0].n, 1);
  // the broadcast-style trigger (ENABLE ALWAYS) still fired on arch for the synced row
  assert.equal((await q(sql.arch, "select count(*)::int as n from broadcasts"))[0].n, before + 1);
});

test("update on arch reaches online", async () => {
  await app.arch.query("update parent set name = 'p1-renamed' where name = 'p1'");
  await settle();
  assert.equal((await q(sql.cloud, "select count(*)::int as n from parent where name = 'p1-renamed'"))[0].n, 1);
});

test("a row created on arch then a cascading delete on online", async () => {
  const [{ id }] = await q(sql.cloud, "select id from parent where name = 'p2'");
  await app.arch.query("insert into child (parent_id, n) values ($1, 7)", [id]);
  await settle();
  assert.equal((await q(sql.cloud, "select count(*)::int as n from child where parent_id = $1", [id]))[0].n, 1);
  await app.cloud.query("delete from parent where id = $1", [id]);
  await settle();
  assert.equal((await q(sql.arch, "select count(*)::int as n from parent where id = $1", [id]))[0].n, 0);
  assert.equal((await q(sql.arch, "select count(*)::int as n from child where parent_id = $1", [id]))[0].n, 0);
});

test("newest edit wins when both sides change the same row", async () => {
  await app.cloud.query("update multi set v = 'from-online' where a = 1");
  await app.arch.query("update multi set v = 'from-arch' where a = 1"); // later
  await settle();
  assert.equal((await q(sql.cloud, "select v from multi where a = 1"))[0].v, "from-arch");
  assert.equal((await q(sql.arch, "select v from multi where a = 1"))[0].v, "from-arch");
});

test("composite key change, generated column and exact types", async () => {
  await app.cloud.query("update multi set b = 'y' where a = 1 and b = 'x'");
  await app.cloud.query("insert into gen (id, x) values (1, 5)");
  await app.arch.query(
    "insert into typed values (1, 123456789012.34, '{a,\"b c\"}', '{\"n\":{\"deep\":[1,2.50]}}', '2026-10-09 12:34:56.123456+00')",
  );
  await settle();
  assert.deepEqual(await rows(sql.arch, "multi", "a, b"), [{ a: 1, b: "y", v: "from-arch" }]);
  assert.equal((await q(sql.arch, "select y from gen where id = 1"))[0].y, 10);
  const t = "select amount::text, tags, meta::text, at::text from typed where id = 1";
  assert.deepEqual(await q(sql.cloud, t), await q(sql.arch, t));
  assert.equal((await q(sql.cloud, t))[0].amount, "123456789012.34");
});

test("a unique clash is logged and the rest of the batch still applies", async () => {
  await app.cloud.query("insert into uniq values (1, 'same@x')");
  await app.arch.query("insert into uniq values (2, 'same@x')");
  await app.cloud.query("insert into parent (name) values ('same-batch')");
  await settle().catch(() => {}); // conflicts don't block, they just aren't applied
  assert.equal((await q(sql.arch, "select count(*)::int as n from parent where name = 'same-batch'"))[0].n, 1);
  const logged = await q(sql.arch, "select tbl, reason from _sync.conflicts where tbl = 'public.uniq'");
  assert.ok(logged.length >= 1 && /unique|duplicate/i.test(logged[0].reason), JSON.stringify(logged));
});

test("tables on one side only are left alone, and nothing echoes", async () => {
  await app.cloud.query("insert into only_cloud values (1)").catch(async () => {
    await sql.cloud.query("insert into only_cloud values (1)");
  });
  await settle();
  const count = async (db) => (await q(db, "select count(*)::int as n from _sync.changes"))[0].n;
  const [c0, a0] = [await count(sql.cloud), await count(sql.arch)];
  assert.equal(await tick(ctx), 0);
  assert.deepEqual([await count(sql.cloud), await count(sql.arch)], [c0, a0]);
});

test("createContext refuses a hosted URL for arch", () => {
  assert.throws(
    () => createContext({ archUrl: "postgresql://x@aws-0-eu-west-1.pooler.supabase.com:5432/postgres", cloudUrl: CLOUD }),
    /hosted Supabase/,
  );
});
