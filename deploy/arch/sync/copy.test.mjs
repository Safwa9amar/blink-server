/**
 * `copy` mode against two SCRATCH databases (never real ones):
 *
 *   TEST_COPY_CLOUD_URL=postgresql://syncer@127.0.0.1:55432/sync_test_copy_cloud \
 *   TEST_COPY_ARCH_URL=postgresql://syncer@127.0.0.1:55432/sync_test_copy_arch \
 *   node --test deploy/arch/sync/copy.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { close, copyOnce, createContext } from "./sync.mjs";

const CLOUD = process.env.TEST_COPY_CLOUD_URL;
const ARCH = process.env.TEST_COPY_ARCH_URL;
if (!/sync_test/.test(CLOUD ?? "") || !/sync_test/.test(ARCH ?? "")) {
  throw new Error("TEST_COPY_*_URL must point at scratch databases named *sync_test*");
}

const SCHEMA = `
drop schema if exists _sync cascade;
drop table if exists child, parent, gen, only_arch cascade;
drop sequence if exists code_seq;
create sequence code_seq start 100001;
create table parent (id uuid primary key default gen_random_uuid(), name text not null,
                     code text default 'BK-' || nextval('code_seq'));
create table child (id uuid primary key default gen_random_uuid(),
                    parent_id uuid references parent(id) on delete cascade, meta jsonb);
create table gen (id int primary key, x int, y int generated always as (x * 2) stored);
create or replace function guard() returns trigger language plpgsql as $$
begin raise exception 'app trigger must not fire during copy'; end $$;
create trigger trg_guard before insert on child for each row
  when (current_setting('session_replication_role') <> 'replica') execute function guard();
`;

const db = {};
let ctx;
const q = async (c, text, params) => (await c.query(text, params)).rows;

before(async () => {
  for (const [name, url] of [["cloud", CLOUD], ["arch", ARCH]]) {
    db[name] = new pg.Client({ connectionString: url });
    await db[name].connect();
    await db[name].query(SCHEMA);
  }
  await db.cloud.query("drop trigger trg_guard on child");
  await db.cloud.query("insert into parent (name) select 'p' || g from generate_series(1, 1203) g");
  await db.cloud.query("insert into child (parent_id, meta) select id, '{\"n\":[1,2.50]}' from parent where name in ('p1','p2')");
  await db.cloud.query("insert into gen (id, x) values (1, 21)");
  await db.arch.query("create table only_arch (id int primary key)");
  await db.arch.query("insert into only_arch values (7)");
  await db.arch.query("insert into parent (name) values ('arch-seed')"); // must disappear

  ctx = createContext({ archUrl: ARCH, cloudUrl: CLOUD, cloudSsl: false });
  await copyOnce(ctx);
});

after(async () => {
  await close(ctx);
  await db.cloud.end();
  await db.arch.end();
});

test("arch becomes an exact copy of online (multi-batch, FKs, JSON, generated)", async () => {
  for (const t of ["parent", "child", "gen"]) {
    assert.deepEqual(
      await q(db.arch, `select * from ${t} order by id`),
      await q(db.cloud, `select * from ${t} order by id`),
      t,
    );
  }
  assert.equal((await q(db.arch, "select count(*)::int as n from parent where name = 'arch-seed'"))[0].n, 0);
});

test("online is only read: no _sync schema or triggers are created anywhere", async () => {
  for (const c of [db.cloud, db.arch]) {
    assert.equal((await q(c, "select count(*)::int as n from pg_namespace where nspname = '_sync'"))[0].n, 0);
    assert.equal((await q(c, "select count(*)::int as n from pg_trigger where tgname = '_sync_capture'"))[0].n, 0);
  }
});

test("arch-only tables are left alone and sequences continue from online", async () => {
  assert.deepEqual(await q(db.arch, "select id from only_arch"), [{ id: 7 }]);
  const [{ v: cloudSeq }] = await q(db.cloud, "select last_value as v from code_seq");
  const [{ v: archSeq }] = await q(db.arch, "select last_value as v from code_seq");
  assert.equal(archSeq, cloudSeq);
  await db.arch.query("insert into parent (name) values ('after-copy')");
  const [{ code }] = await q(db.arch, "select code from parent where name = 'after-copy'");
  assert.equal(code, `BK-${Number(cloudSeq) + 1}`);
});
