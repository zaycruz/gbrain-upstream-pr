#!/usr/bin/env bun
// scripts/build-eval-fixture.ts
//
// Generates the committed eval fixture the hermetic retrieval-gate seeds.
// Derives one fixture page per UNIQUE gold target in tools/eval/gold.json, so
// the seeded brain contains exactly the pages the 100-question eval can score
// against. This makes the pre-merge gate deterministic: a retrieval regression
// on the PR shows up as gold pages that no longer surface, independent of prod
// data drift.
//
// Each fixture page carries an effective_date (satisfying the WS6c temporal
// write-gate) and frontmatter that lets the temporal/nav/relational arms route
// it. Real page bodies are not needed for a retrieval gate — the engine indexes
// slug + type + title + compiled_truth + effective_date.
//
// Run: bun run scripts/build-eval-fixture.ts
// Output: test/fixtures/eval-fixture.pages.json

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const GOLD_PATH = "tools/eval/gold.json";
const OUT_PATH = "test/fixtures/eval-fixture.pages.json";

// Map a gold slug to a PageType the schema accepts. Curated types get a date;
// everything in the fixture gets one anyway (WS6c compliance).
function inferType(slug: string): string {
  if (slug.startsWith("decisions/") || /adr-|^\d{4}-\d{2}-\d{2}-/.test(slug)) return "note";
  if (slug.startsWith("daily-report") || slug.startsWith("brain-health") || slug.startsWith("health/")) return "report";
  if (slug.startsWith("concepts/lessons/")) return "lesson";
  if (slug.startsWith("docs/brainstorms/")) return "brainstorm";
  if (slug.startsWith("inbox/")) return "note";
  if (slug.startsWith("agents/")) return "note";
  if (slug.startsWith("concepts/engineering/") || slug.startsWith("foundry-internal-api")) return "note";
  return "note";
}

function effectiveDateFor(slug: string): string {
  const m = slug.match(/(20\d\d)-(\d\d)-(\d\d)/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "2026-08-01"; // stable non-date slug → fixed effective date
}

function main() {
  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8")) as Array<{ gold: string[] }>;
  const slugs = new Set<string>();
  for (const item of gold) {
    for (const g of item.gold) slugs.add(g.toLowerCase());
  }

  const pages = [...slugs].sort().map((slug) => ({
    slug,
    sourceId: "raava-brain",
    page: {
      type: inferType(slug),
      title: slug.split("/").pop() ?? slug,
      compiled_truth: `Fixture page for ${slug}. Seeded by build-eval-fixture for the hermetic retrieval gate.`,
      timeline: "",
      frontmatter: { fixture: true },
      effective_date: new Date(effectiveDateFor(slug)),
      effective_date_source: "frontmatter",
    },
  }));

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(pages, null, 2));
  console.log(`[build-eval-fixture] wrote ${pages.length} fixture pages -> ${OUT_PATH}`);
}

main();
