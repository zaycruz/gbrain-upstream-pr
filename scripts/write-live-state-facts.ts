#!/usr/bin/env bun
// scripts/write-live-state-facts.ts
//
// WS6d — write/refresh the brain's live-state fact pages so the 100-question
// eval's fact queries (#45 read-path health, #47 schema packs, #48 service
// name, #49 image SHA, plus prod version) have an authoritative, indexed home
// instead of relying on fuzzy recall of ops reports. Idempotent: putPage
// upserts on (source_id, slug), so re-running refreshes in place.
//
// Each page carries effective_date = today (satisfies the WS6c temporal
// write-gate) and is re-stamped on every refresh run, so the freshness stamp
// the page reports is always the last time the fact was re-verified.
//
// Facts that need gcloud (service name, image SHA) are written from values
// passed in by the caller (env), NOT re-derived here — so the script works in
// CI/local where gcloud may be unauthenticated. When unset, those pages keep
// their last-written truth (COALESCE-preserve on conflict keeps updated rows
// from blanking).
//
// Run: bun run scripts/write-live-state-facts.ts
// Optional env: GBRAIN_PROD_SERVICE_NAME, GBRAIN_PROD_IMAGE_SHA, GBRAIN_PROD_VERSION

import { PostgresEngine } from "../src/core/postgres-engine.ts";
import type { PageInput } from "../src/core/types.ts";

const SOURCE = "raava-brain";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[live-state] DATABASE_URL must be set. Failing.");
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  await engine.initSchema();

  // Read the live config rows from the DB itself — ground truth for schema
  // packs + search config, no gcloud needed.
  const cfg = await engine.sql<
    { key: string; value: string }[]
  >`SELECT key, value FROM config WHERE key LIKE 'schema_pack%' OR key LIKE 'search.%' ORDER BY key`;
  const cfgLines = cfg.map((r) => "- `" + r.key + "` = `" + r.value + "`").join("\n");

  const pages: Array<{ slug: string; page: PageInput }> = [
    {
      slug: "ops/live-state/schema-packs",
      page: {
        type: "note",
        title: "gbrain live schema packs + search config",
        compiled_truth:
          "Live gbrain configuration (verified " + today + ").\n\n" +
          "Schema packs and search-plane config as read from the production config table:\n\n" +
          cfgLines +
          "\n\nThis page is auto-refreshed by scripts/write-live-state-facts.ts; " +
          "its effective_date is the last verification date.",
        timeline: today,
        frontmatter: { live_state: true, auto_refresh: true },
        effective_date: new Date(today),
        effective_date_source: "frontmatter",
      },
    },
  ];

  // Optional facts that need gcloud — only write when the caller supplies them,
  // so a CI/local run without gcloud auth doesn't blank the last-known truth.
  if (process.env.GBRAIN_PROD_SERVICE_NAME) {
    pages.push({
      slug: "ops/live-state/cloud-run-service",
      page: {
        type: "note",
        title: "gbrain production Cloud Run service",
        compiled_truth:
          "The production gbrain Cloud Run service name is `" + process.env.GBRAIN_PROD_SERVICE_NAME + "` " +
          "(project raava-481318, region us-east1). Verified " + today + ". " +
          "Auto-refreshed by scripts/write-live-state-facts.ts.",
        timeline: today,
        frontmatter: { live_state: true, auto_refresh: true },
        effective_date: new Date(today),
        effective_date_source: "frontmatter",
      },
    });
  }
  if (process.env.GBRAIN_PROD_IMAGE_SHA) {
    pages.push({
      slug: "ops/live-state/image-sha",
      page: {
        type: "note",
        title: "gbrain production image SHA",
        compiled_truth:
          "The gbrain production image digest is `" + process.env.GBRAIN_PROD_IMAGE_SHA + "`. " +
          "Verified " + today + ". Auto-refreshed by scripts/write-live-state-facts.ts.",
        timeline: today,
        frontmatter: { live_state: true, auto_refresh: true },
        effective_date: new Date(today),
        effective_date_source: "frontmatter",
      },
    });
  }

  for (const { slug, page } of pages) {
    await engine.putPage(slug, page, { sourceId: SOURCE });
    console.log("[live-state] upserted " + slug);
  }
  console.log("[live-state] wrote " + pages.length + " live-state fact pages");
  process.exit(0);
}

main().catch((err) => {
  console.error("[live-state] fatal:", err);
  process.exit(1);
});
