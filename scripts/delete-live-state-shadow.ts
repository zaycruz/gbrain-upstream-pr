#!/usr/bin/env bun
// scripts/delete-live-state-shadow.ts
//
// WS6d cleanup — delete the DB-only shadow page ops/live-state/schema-packs.
// That page was written straight to the DB by write-live-state-op.ts and has
// no git backing, which violates the vault-canonical rule (markdown in git is
// the source of truth). The git-backed replacement is
// state/live-state/schema-packs.md (raava-solutions/raava-brain PR #164);
// the push-sync workflow indexes it into the DB from origin/main.
//
// Run: DATABASE_URL=... bun run scripts/delete-live-state-shadow.ts

import { PostgresEngine } from "../src/core/postgres-engine.ts";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[delete-shadow] DATABASE_URL must be set. Failing.");
    process.exit(1);
  }
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  await engine.initSchema();

  const existing = await engine.getPage("ops/live-state/schema-packs");
  if (!existing) {
    console.log("[delete-shadow] ops/live-state/schema-packs not present — nothing to do");
    process.exit(0);
  }
  await engine.deletePage("ops/live-state/schema-packs", { sourceId: "raava-brain" });
  const after = await engine.getPage("ops/live-state/schema-packs");
  console.log(
    after
      ? "[delete-shadow] FAILED: page still present after deletePage"
      : "[delete-shadow] deleted ops/live-state/schema-packs (DB-only shadow removed)"
  );
  process.exit(after ? 1 : 0);
}

main().catch((err) => {
  console.error("[delete-shadow] fatal:", err);
  process.exit(1);
});
