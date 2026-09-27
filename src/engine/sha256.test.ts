import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { Sha256 } from "./sha256";

describe("incremental sha256", () => {
  test("matches node for empty, abc and odd chunkings", () => {
    expect(new Sha256().hex()).toBe(createHash("sha256").digest("hex"));
    expect(new Sha256().update(new TextEncoder().encode("abc")).hex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const data = new Uint8Array(100_003).map((_, i) => (i * 31 + 7) & 255);
    const want = createHash("sha256").update(data).digest("hex");
    for (const chunk of [1, 55, 63, 64, 65, 1000, 100_003]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += chunk) h.update(data.subarray(i, i + chunk));
      expect(h.hex()).toBe(want);
    }
  });
});
