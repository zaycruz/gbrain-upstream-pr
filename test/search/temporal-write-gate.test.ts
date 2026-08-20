// WS6c — temporal write-gate regression tests.
// putPage must hard-reject human/curated writes that carry no effective_date,
// and must pass dateless machine types + deliberate curated imports.
import { describe, expect, test } from "bun:test";

// The gate is pure input validation in putPage before any SQL fires, so we
// drive it with a PostgresEngine whose connection is never used. The throw
// happens before `this.sql` is dereferenced for the insert.
import { PostgresEngine } from "../../src/core/postgres-engine.ts";
import type { PageInput } from "../../src/core/types.ts";

function page(over: Partial<PageInput>): PageInput {
  return { type: "note", title: "t", compiled_truth: "c", ...over } as PageInput;
}

describe("temporal write-gate (WS6c)", () => {
  test("rejects a curated type with no effective_date", async () => {
    const engine = new PostgresEngine();
    await expect(
      engine.putPage("decisions/x", page({ type: "note" }))
    ).rejects.toThrow(/missing timestamp/i);
  });

  test("accepts a curated type WITH effective_date", async () => {
    const engine = new PostgresEngine();
    // Gets past the gate and fails later on the missing connection — proving
    // the guard did NOT fire.
    await expect(
      engine.putPage("decisions/x", page({ type: "note", effective_date: new Date("2026-08-20") }))
    ).rejects.not.toThrow(/missing timestamp/i);
  });

  test("dateless machine types pass without effective_date", async () => {
    const engine = new PostgresEngine();
    for (const t of ["atom", "extract_receipt", "event", "diary", "conversation"]) {
      await expect(
        engine.putPage(`atoms/${t}-x`, page({ type: t }))
      ).rejects.not.toThrow(/missing timestamp/i);
    }
  });

  test("GBRAIN_ALLOW_DATELESS_WRITE=1 escape hatch bypasses the gate", async () => {
    process.env.GBRAIN_ALLOW_DATELESS_WRITE = "1";
    try {
      const engine = new PostgresEngine();
      await expect(
        engine.putPage("decisions/x", page({ type: "note" }))
      ).rejects.not.toThrow(/missing timestamp/i);
    } finally {
      delete process.env.GBRAIN_ALLOW_DATELESS_WRITE;
    }
  });
});
