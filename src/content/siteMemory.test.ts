import { describe, expect, test } from "vitest";
import { clearSiteMemory, getSiteTally, pushScore, recordSiteScore, tallyOf } from "./siteMemory";

describe("pushScore / tallyOf (pure)", () => {
  test("caps the ring buffer at 10 entries, keeping the most recent", () => {
    let entry = undefined as ReturnType<typeof pushScore> | undefined;
    for (let i = 0; i < 12; i++) entry = pushScore(entry, i % 2 === 0, `2026-01-${String(i + 1).padStart(2, "0")}`);
    expect(entry!.entries).toHaveLength(10);
    // The oldest two (i=0,1) were dropped.
    expect(entry!.entries[0]!.date).toBe("2026-01-03");
  });

  test("tallyOf counts high vs total", () => {
    const entry = { entries: [{ high: true, date: "a" }, { high: true, date: "b" }, { high: false, date: "c" }] };
    expect(tallyOf(entry)).toEqual({ high: 2, total: 3 });
  });

  test("tallyOf is null with no history", () => {
    expect(tallyOf(undefined)).toBeNull();
  });
});

describe("recordSiteScore / getSiteTally / clearSiteMemory (storage-backed)", () => {
  test("records and tallies per hostname", async () => {
    await clearSiteMemory();
    await recordSiteScore("example.com", true);
    await recordSiteScore("example.com", true);
    await recordSiteScore("example.com", false);
    await recordSiteScore("other.example", false);

    expect(await getSiteTally("example.com")).toEqual({ high: 2, total: 3 });
    expect(await getSiteTally("other.example")).toEqual({ high: 0, total: 1 });
    expect(await getSiteTally("never-seen.example")).toBeNull();
  });

  test("clearSiteMemory erases every domain", async () => {
    await recordSiteScore("example.com", true);
    await clearSiteMemory();
    expect(await getSiteTally("example.com")).toBeNull();
  });
});
