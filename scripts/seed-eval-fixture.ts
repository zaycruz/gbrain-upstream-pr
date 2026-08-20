#!/usr/bin/env bun
// scripts/seed-eval-fixture.ts
//
// Hermetic retrieval-gate seeder. Boots a PostgresEngine against the CI-provided
// DATABASE_URL (pgvector/pgvector:pg16 service), runs initSchema (forward
// bootstrap + all migrations), then loads the committed eval fixture pages so
// the 100-question eval has a deterministic corpus to query. Hard-fails when
// DATABASE_URL is absent — a silent skip would let a retrieval regression merge.
//
// Run: bun run scripts/seed-eval-fixture.ts
// Requires: DATABASE_URL (e2e.yml pattern).

import { readFileSync } from "node:fs";
import { PostgresEngine } from "../src/core/postgres-engine.ts";
import type { PageInput } from "../src/core/types.ts";

const FIXTURE_PATH = "test/fixtures/eval-fixture.pages.json";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "[seed-eval-fixture] DATABASE_URL must be set — the retrieval gate would silently skip and merge green. Failing."
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Array<{
    slug: string;
    page: PageInput;
    sourceId?: string;
  }>;
  console.log(`[seed-eval-fixture] loading ${raw.length} fixture pages from ${FIXTURE_PATH}`);

  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  await engine.initSchema();

  for (const { slug, page, sourceId } of raw) {
    await engine.putPage(slug, page, sourceId ? { sourceId } : undefined);
  }

  console.log(`[seed-eval-fixture] seeded ${raw.length} pages; fixture brain ready`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-eval-fixture] fatal:", err);
  process.exit(1);
});
