// Schema barrel — every table + enum the Blink DB exposes.
// `drizzle.config.ts` points here; consumers import types from `../index`.
//
// The 9 baseline tables already live in the Supabase DB (snapshot 0000).
// `news` (below) is the first table authored in Drizzle and shipped as the
// additive 0001 migration.

export * from "./enums";
export * from "./users";
export * from "./rider-profiles";
export * from "./vehicles";
export * from "./trips";
export * from "./transactions";
export * from "./agent-shops";
export * from "./agent-profiles";
export * from "./orders";
export * from "./notifications";
export * from "./device-tokens";
export * from "./addresses";
export * from "./news";
export * from "./deep-links";
