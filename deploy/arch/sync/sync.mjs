/**
 * DEV ONLY — two-way row sync between the self-hosted Supabase on `arch` and the
 * online Supabase project (a dev-only database for this team).
 *
 * How it works
 *  - Each side gets a `_sync` schema. An AFTER row trigger (`_sync_capture`) on
 *    every synced table logs the primary key of each changed row to
 *    `_sync.changes`. The worker reads the row's *current* state when shipping it,
 *    so bursts of edits collapse and order doesn't matter.
 *  - Synced tables = every `public` table, plus auth.users / auth.identities,
 *    that exists on both sides with the same primary key. Tables added by later
 *    migrations are picked up on the next catalog refresh (every minute).
 *  - Each tick, per direction: new change ids are collapsed per row and the row
 *    is upserted (still exists) or deleted (gone) on the other side, in one
 *    transaction with `session_replication_role = replica`:
 *      · ordinary triggers don't fire, so applied rows are not captured again (no
 *        echo) and side effects (notification fan-out, guards) aren't duplicated:
 *        the rows those side effects produced are synced in their own right;
 *      · realtime broadcast triggers (functions calling realtime.send) are set to
 *        ENABLE ALWAYS, so synced rows still notify that side's clients.
 *  - Conflicts: newest edit wins. A row is skipped when the other side holds an
 *    unshipped, newer change to it (that change then flows back). Rows that fail
 *    to apply (e.g. the same email created on both sides) are logged to
 *    `_sync.conflicts` on arch and skipped; the worker keeps going.
 *  - Not synced: auth sessions / refresh tokens (sign in per side), storage files.
 *
 * Usage — env: ARCH_DB_URL, CLOUD_DB_URL [, CLOUD_DB_SSL=1, SYNC_TICK_MS=2000]
 *   node sync.mjs copy --wipe-arch        # one-off: arch := copy of online (online only read)
 *   node sync.mjs bootstrap --wipe-arch   # arch := copy of online, start capture
 *   node sync.mjs                         # sync forever
 */
import pg from "pg";

const TICK_MS = Number(process.env.SYNC_TICK_MS ?? 2000);
const CATALOG_REFRESH_MS = 60_000;
const PRUNE_MS = 10 * 60_000;
const BATCH = 500;
/** arch's ID sequences start this far above online's, so new IDs never collide. */
const ARCH_SEQUENCE_OFFSET = 500_000;
const EXTRA_TABLES = ["auth.users", "auth.identities"];
/** Per-login auth state: not synced, cleared on arch by bootstrap. */
const ARCH_SESSION_TABLES = [
  "auth.refresh_tokens", "auth.mfa_amr_claims", "auth.mfa_challenges", "auth.mfa_factors",
  "auth.sessions", "auth.one_time_tokens", "auth.flow_state",
];

const log = (...args) => console.log(new Date().toISOString(), ...args);
const ident = (s) => `"${s.replaceAll('"', '""')}"`;
const lit = (s) => `'${s.replaceAll("'", "''")}'`;
const tableIdent = (name) => name.split(".").map(ident).join(".");

const SETUP_SQL = `
create schema if not exists _sync;
revoke all on schema _sync from public;
create table if not exists _sync.changes (
  id bigserial primary key,
  tbl text not null,
  pk jsonb not null,
  at timestamptz not null default clock_timestamp()
);
create index if not exists changes_tbl_pk on _sync.changes (tbl, pk);
create table if not exists _sync.state (key text primary key, value bigint not null);
create table if not exists _sync.conflicts (
  id bigserial primary key,
  at timestamptz not null default now(),
  direction text not null,
  tbl text not null,
  pk jsonb not null,
  reason text not null
);
create or replace function _sync.capture() returns trigger
language plpgsql security definer set search_path = pg_catalog as $fn$
declare
  newk jsonb;
  oldk jsonb;
  c text;
begin
  -- tg_argv = primary-key column names. An UPDATE that changes the key logs
  -- both keys, so the old one is deleted on the other side.
  if tg_op <> 'DELETE' then
    newk := '{}';
    foreach c in array tg_argv loop
      newk := newk || jsonb_build_object(c, to_jsonb(new) -> c);
    end loop;
    insert into _sync.changes (tbl, pk) values (tg_table_schema || '.' || tg_table_name, newk);
  end if;
  if tg_op <> 'INSERT' then
    oldk := '{}';
    foreach c in array tg_argv loop
      oldk := oldk || jsonb_build_object(c, to_jsonb(old) -> c);
    end loop;
    if newk is distinct from oldk then
      insert into _sync.changes (tbl, pk) values (tg_table_schema || '.' || tg_table_name, oldk);
    end if;
  end if;
  return null;
end
$fn$;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema _sync from %I', r);
      execute format('revoke all on all tables in schema _sync from %I', r);
    end if;
  end loop;
end $$;
`;

const CATALOG_SQL = `
select n.nspname || '.' || c.relname as name,
       array(select a.attname::text
               from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
              order by k.ord) as pk,
       array(select a.attname::text from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
              order by a.attnum) as cols,
       array(select a.attname::text from pg_attribute a
              where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                and (a.attgenerated <> '' or a.attidentity = 'a')) as readonly,
       exists(select 1 from pg_trigger t
               where t.tgrelid = c.oid and t.tgname = '_sync_capture') as captured
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_index i on i.indrelid = c.oid and i.indisprimary
 where c.relkind = 'r'
   and (n.nspname = 'public' or n.nspname || '.' || c.relname = any($1::text[]))`;

const BROADCAST_SQL = `
select format('alter table %s enable always trigger %I', t.tgrelid::regclass, t.tgname) as sql
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal and t.tgenabled = 'O'
   and p.prosrc ilike '%realtime.send%'`;

// ── connections ──────────────────────────────────────────────────────────────

export function createContext({ archUrl, cloudUrl, cloudSsl = true }) {
  if (!archUrl || !cloudUrl) throw new Error("ARCH_DB_URL and CLOUD_DB_URL are required");
  if (archUrl === cloudUrl) throw new Error("ARCH_DB_URL and CLOUD_DB_URL must differ");
  if (/supabase\.(co|com)\b/.test(archUrl)) {
    throw new Error("ARCH_DB_URL points at a hosted Supabase project; refusing");
  }
  return {
    arch: { name: "arch", url: archUrl, ssl: false, db: null },
    cloud: { name: "cloud", url: cloudUrl, ssl: cloudSsl, db: null },
    tables: new Map(),
    catalogAt: 0,
    prunedAt: Date.now(),
  };
}

async function connect(side) {
  if (side.db) return side.db;
  const db = new pg.Client({
    connectionString: side.url,
    ssl: side.ssl ? { rejectUnauthorized: false } : false,
    application_name: "blink-sync",
  });
  db.on("error", (e) => {
    log(`[${side.name}] connection lost: ${e.message}`);
    if (side.db === db) side.db = null;
  });
  await db.connect();
  side.db = db;
  return db;
}

export async function close(ctx) {
  for (const side of [ctx.arch, ctx.cloud]) {
    await side.db?.end().catch(() => {});
    side.db = null;
  }
}

// ── state (kept on arch) ─────────────────────────────────────────────────────

async function getState(ctx, key) {
  const { rows } = await ctx.arch.db.query("select value from _sync.state where key = $1", [key]);
  return rows.length ? Number(rows[0].value) : 0;
}

async function setState(ctx, key, value) {
  await ctx.arch.db.query(
    `insert into _sync.state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value`,
    [key, value],
  );
}

async function recordConflict(ctx, direction, ch, reason) {
  log(`conflict ${direction} ${ch.tbl} ${ch.pk}: ${reason}`);
  await ctx.arch.db.query(
    "insert into _sync.conflicts (direction, tbl, pk, reason) values ($1, $2, $3::jsonb, $4)",
    [direction, ch.tbl, ch.pk, reason],
  );
}

// ── catalog ──────────────────────────────────────────────────────────────────

async function loadCatalog(side) {
  const { rows } = await side.db.query(CATALOG_SQL, [EXTRA_TABLES]);
  return new Map(rows.map((r) => [r.name, r]));
}

/** Tables present on both sides with the same primary key. */
function matchTables(archCat, cloudCat) {
  const tables = new Map();
  const skipped = [];
  for (const name of new Set([...archCat.keys(), ...cloudCat.keys()])) {
    const a = archCat.get(name);
    const c = cloudCat.get(name);
    if (!a || !c || a.pk.join() !== c.pk.join()) {
      skipped.push(name);
      continue;
    }
    const common = a.cols.filter((col) => c.cols.includes(col));
    tables.set(name, {
      name,
      ident: tableIdent(name),
      pk: a.pk,
      // what can be written into each side: shared columns minus that side's
      // generated / identity-always columns
      writable: {
        arch: common.filter((col) => !a.readonly.includes(col)),
        cloud: common.filter((col) => !c.readonly.includes(col)),
      },
    });
  }
  return { tables, skipped };
}

async function refreshCatalog(ctx) {
  const [archCat, cloudCat] = [await loadCatalog(ctx.arch), await loadCatalog(ctx.cloud)];
  const { tables, skipped } = matchTables(archCat, cloudCat);
  for (const [side, cat] of [[ctx.arch, archCat], [ctx.cloud, cloudCat]]) {
    for (const t of tables.values()) {
      if (cat.get(t.name).captured) continue;
      await side.db.query(
        `create or replace trigger _sync_capture after insert or update or delete on ${t.ident}
         for each row execute function _sync.capture(${t.pk.map(lit).join(", ")})`,
      );
      log(`[${side.name}] capturing ${t.name}`);
    }
    const { rows } = await side.db.query(BROADCAST_SQL);
    for (const { sql } of rows) {
      await side.db.query(sql);
      log(`[${side.name}] ${sql}`);
    }
  }
  if (tables.size !== ctx.tables.size) {
    log(`syncing ${tables.size} tables; not synced (one side only / PK differs): ${skipped.join(", ") || "none"}`);
  }
  ctx.tables = tables;
  ctx.catalogAt = Date.now();
}

// ── sql builders ─────────────────────────────────────────────────────────────

/** `(alias.pk1, ...) = (pk values decoded from the $1 jsonb)` */
function pkMatch(t, alias) {
  const lhs = t.pk.map((c) => `${alias}.${ident(c)}`).join(", ");
  const rhs = t.pk.map((c) => `r.${ident(c)}`).join(", ");
  return `(${lhs}) = (select ${rhs} from jsonb_populate_record(null::${t.ident}, $1::jsonb) r)`;
}

function upsertSql(t, into, { recordset = false } = {}) {
  const cols = t.writable[into];
  const list = cols.map(ident).join(", ");
  const updates = cols
    .filter((c) => !t.pk.includes(c))
    .map((c) => `${ident(c)} = excluded.${ident(c)}`);
  const source = recordset
    ? `jsonb_populate_recordset(null::${t.ident}, $1::jsonb)`
    : `jsonb_populate_record(null::${t.ident}, $1::jsonb)`;
  return `insert into ${t.ident} (${list}) select ${list} from ${source}
          on conflict (${t.pk.map(ident).join(", ")})
          do ${updates.length ? `update set ${updates.join(", ")}` : "nothing"}`;
}

// ── sync ─────────────────────────────────────────────────────────────────────

/** Ship new changes from `src` to `dst`. Returns the number of rows applied. */
async function pump(ctx, src, dst) {
  const direction = `${src.name}->${dst.name}`;
  const cursor = await getState(ctx, `${src.name}_cursor`);
  const { rows: changes } = await src.db.query(
    `select id, tbl, pk::text as pk, at::text as at from _sync.changes
      where id > $1 order by id limit ${BATCH}`,
    [cursor],
  );
  if (changes.length === 0) return 0;

  const latest = new Map(); // one entry per row, keeping its newest change
  for (const ch of changes) latest.set(`${ch.tbl}\u0000${ch.pk}`, ch);
  const dstCursor = await getState(ctx, `${dst.name}_cursor`);

  let applied = 0;
  await dst.db.query("begin");
  try {
    await dst.db.query("set local session_replication_role = replica");
    for (const ch of latest.values()) {
      const t = ctx.tables.get(ch.tbl);
      if (!t) continue;
      const { rowCount: newerOnDst } = await dst.db.query(
        `select 1 from _sync.changes
          where id > $1 and tbl = $2 and pk = $3::jsonb and at > $4::timestamptz limit 1`,
        [dstCursor, ch.tbl, ch.pk, ch.at],
      );
      if (newerOnDst) {
        log(`${direction} ${ch.tbl} ${ch.pk}: kept the newer ${dst.name} edit`);
        continue;
      }
      const { rows } = await src.db.query(
        `select to_jsonb(s)::text as row from ${t.ident} s where ${pkMatch(t, "s")}`,
        [ch.pk],
      );
      await dst.db.query("savepoint row_apply");
      try {
        if (rows.length) await dst.db.query(upsertSql(t, dst.name), [rows[0].row]);
        else await dst.db.query(`delete from ${t.ident} d where ${pkMatch(t, "d")}`, [ch.pk]);
        await dst.db.query("release savepoint row_apply");
        applied++;
      } catch (e) {
        await dst.db.query("rollback to savepoint row_apply");
        await recordConflict(ctx, direction, ch, e.message);
      }
    }
    await dst.db.query("commit");
  } catch (e) {
    await dst.db.query("rollback").catch(() => {});
    throw e;
  }
  await setState(ctx, `${src.name}_cursor`, Number(changes.at(-1).id));
  if (applied) log(`${direction}: ${applied} row(s)`);
  return applied;
}

async function prune(ctx) {
  for (const side of [ctx.arch, ctx.cloud]) {
    const shipped = await getState(ctx, `${side.name}_cursor`);
    await side.db.query(
      "delete from _sync.changes where id <= $1 and at < now() - interval '1 day'",
      [shipped],
    );
  }
  ctx.prunedAt = Date.now();
}

/** One sync round in both directions. Returns rows applied. */
export async function tick(ctx) {
  await connect(ctx.arch);
  await connect(ctx.cloud);
  if (Date.now() - ctx.catalogAt > CATALOG_REFRESH_MS) await refreshCatalog(ctx);
  const applied = (await pump(ctx, ctx.cloud, ctx.arch)) + (await pump(ctx, ctx.arch, ctx.cloud));
  if (Date.now() - ctx.prunedAt > PRUNE_MS) await prune(ctx);
  return applied;
}

export async function setup(ctx) {
  await connect(ctx.arch);
  await connect(ctx.cloud);
  await ctx.arch.db.query(SETUP_SQL);
  await ctx.cloud.db.query(SETUP_SQL);
  await refreshCatalog(ctx);
}

async function maxChangeId(side) {
  const { rows } = await side.db.query("select coalesce(max(id), 0) as id from _sync.changes");
  return Number(rows[0].id);
}

/**
 * Make arch an exact copy of online for every synced table, then start
 * capturing on both sides. Only ever deletes on arch.
 */
export async function bootstrap(ctx) {
  await setup(ctx); // capture is live on online from here on
  const cloudStart = await maxChangeId(ctx.cloud);
  await copyCloudToArch(ctx, ARCH_SEQUENCE_OFFSET);
  await setState(ctx, "cloud_cursor", cloudStart);
  await setState(ctx, "arch_cursor", await maxChangeId(ctx.arch));
  log(`bootstrap done: ${ctx.tables.size} tables copied online -> arch`);
}

/**
 * One-way, one-off: replace arch's data with a copy of online's. Online is only
 * read (no `_sync` schema or triggers are installed anywhere); arch's ID
 * sequences continue from online's.
 */
export async function copyOnce(ctx) {
  await connect(ctx.arch);
  await connect(ctx.cloud);
  ctx.tables = matchTables(await loadCatalog(ctx.arch), await loadCatalog(ctx.cloud)).tables;
  await copyCloudToArch(ctx, 0);
  log(`copy done: ${ctx.tables.size} tables copied online -> arch`);
}

/** Wipe + reload every matched table on arch from online, in one transaction. */
async function copyCloudToArch(ctx, sequenceOffset) {
  const arch = ctx.arch.db;
  const cloud = ctx.cloud.db;

  await arch.query("begin");
  try {
    // replica mode: nothing below is captured, and no app triggers fire
    await arch.query("set local session_replication_role = replica");
    for (const name of ARCH_SESSION_TABLES) {
      const { rows } = await arch.query("select to_regclass($1) is not null as ok", [name]);
      if (rows[0].ok) await arch.query(`delete from ${tableIdent(name)}`);
    }
    for (const t of ctx.tables.values()) await arch.query(`delete from ${t.ident}`);

    for (const t of ctx.tables.values()) {
      let copied = 0;
      for (let offset = 0; ; offset += BATCH) {
        const { rows } = await cloud.query(
          `select coalesce(jsonb_agg(to_jsonb(s)), '[]')::text as batch, count(*) as n
             from (select * from ${t.ident} order by ${t.pk.map(ident).join(", ")}
                   limit ${BATCH} offset ${offset}) s`,
        );
        if (Number(rows[0].n) === 0) break;
        await arch.query(upsertSql(t, "arch", { recordset: true }), [rows[0].batch]);
        copied += Number(rows[0].n);
      }
      if (copied) log(`copied ${t.name}: ${copied} row(s)`);
    }

    // Continue online's sequences (BK-RR-…, etc.); with an offset, arch gets
    // its own range so two-way sync never mints the same ID on both sides.
    const { rows: seqs } = await cloud.query(
      "select schemaname || '.' || sequencename as name, coalesce(last_value, 0) as v from pg_sequences where schemaname = 'public'",
    );
    for (const s of seqs) {
      const { rows } = await arch.query("select to_regclass($1) is not null as ok", [s.name]);
      if (!rows[0].ok) continue;
      const next = Number(s.v) + sequenceOffset;
      if (next >= 1) await arch.query("select setval($1::regclass, $2)", [s.name, next]);
      else await arch.query("select setval($1::regclass, 1, false)", [s.name]);
    }
    await arch.query("commit");
  } catch (e) {
    await arch.query("rollback").catch(() => {});
    throw e;
  }
}

// ── cli ──────────────────────────────────────────────────────────────────────

async function main() {
  const [mode = "run", flag] = process.argv.slice(2);
  const ctx = createContext({
    archUrl: process.env.ARCH_DB_URL,
    cloudUrl: process.env.CLOUD_DB_URL,
    cloudSsl: process.env.CLOUD_DB_SSL !== "0",
  });
  if (mode === "bootstrap") {
    if (flag !== "--wipe-arch") throw new Error("bootstrap replaces arch's data: pass --wipe-arch");
    await bootstrap(ctx);
    await close(ctx);
    return;
  }
  if (mode === "copy") {
    if (flag !== "--wipe-arch") throw new Error("copy replaces arch's data: pass --wipe-arch");
    await copyOnce(ctx);
    await close(ctx);
    return;
  }
  if (mode !== "run") throw new Error(`unknown mode ${mode}`);

  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop = true; });
  log(`sync running every ${TICK_MS} ms`);
  let backoff = TICK_MS;
  while (!stop) {
    try {
      await tick(ctx);
      backoff = TICK_MS;
    } catch (e) {
      log(`tick failed: ${e.message}`);
      await close(ctx); // reconnect next round
      ctx.catalogAt = 0;
      backoff = Math.min(backoff * 2, 60_000);
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
  await close(ctx);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
