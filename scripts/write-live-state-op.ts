#!/usr/bin/env bun
// scripts/write-live-state-op.ts
//
// WS6d — write/refresh live-state fact pages through the put_page OPERATION
// (importFromContent), NOT raw engine.putPage. The operation is the only write
// path that chunks + embeds, so a fact written here is actually searchable.
// The earlier write-live-state-facts.ts used engine.putPage directly and left
// the page un-chunked (0 content_chunks) — invisible to search.
//
// Each page's markdown carries `date: <today>` frontmatter so the importer's
// computeEffectiveDate picks it up and the WS6c temporal write-gate passes.
// Git note: put_page does NOT write back to the vault/git (per product). These
// live-state pages are DB-only operational facts; git remains the source of
// truth for curated content, these are auto-refreshed read-models.
//
// Run: DATABASE_URL=... bun run scripts/write-live-state-op.ts

import { PostgresEngine } from "../src/core/postgres-engine.ts";
import { importFromContent } from "../src/core/import-file.ts";
import { configureGateway } from "../src/core/ai/gateway.ts";
import { buildGatewayConfig } from "../src/core/ai/build-gateway-config.ts";
import { loadConfig } from "../src/core/config.ts";

const SOURCE = "raava-brain";

function factPage(slugTitle: string, body: string, today: string): string {
  return [
    "---",
    "type: note",
    `date: ${today}`,
    "live_state: true",
    "auto_refresh: true",
    "---",
    "",
    `# ${slugTitle}`,
    "",
    body,
    "",
  ].join("\n");
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[live-state-op] DATABASE_URL must be set. Failing.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  // In-process probes must configure the AI gateway before engine.connect or
  // embed() throws AIConfigError (no embedding provider). Build from the
  // resolved gbrain config.
  const cfg0 = loadConfig();
  if (cfg0) configureGateway(buildGatewayConfig(cfg0));
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url });
  await engine.initSchema();

  const cfg = await engine.sql<
    { key: string; value: string }[]
  >`SELECT key, value FROM config WHERE key LIKE 'schema_pack%' OR key LIKE 'search.%' ORDER BY key`;
  const cfgLines = cfg.map((r) => "- `" + r.key + "` = `" + r.value + "`").join("\n");

  const body =
    "Live gbrain configuration (verified " + today + ").\n\n" +
    "Schema packs and search-plane config as read from the production config table:\n\n" +
    cfgLines +
    "\n\nAuto-refreshed by scripts/write-live-state-op.ts via the put_page operation " +
    "(chunked + embedded). effective_date is the last verification date.";

  await importFromContent(
    engine,
    "ops/live-state/schema-packs",
    factPage("gbrain live schema packs + search config", body, today),
    { sourceId: SOURCE }
  );
  console.log("[live-state-op] wrote ops/live-state/schema-packs (chunked + embedded)");
  process.exit(0);
}

main().catch((err) => {
  console.error("[live-state-op] fatal:", err);
  process.exit(1);
});
