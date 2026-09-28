import { describe, expect, test } from "vitest";
import { cleanDescription, wordCount } from "./description";

describe("YouTube description cleaning", () => {
  test("keeps prose, drops links, chapters, hashtag and handle lines", () => {
    const raw = [
      "In this video we take a deep dive into how lithium batteries age, and what you can do about it.",
      "",
      "Sponsor: get 20% off at https://example.com/deal",
      "Follow me on www.instagram.com/someone",
      "Merch: shop.example.io/",
      "0:00 Intro",
      "1:23 Chemistry",
      "(12:05) Results",
      "#batteries #science",
      "@somechannel",
      "Thanks for watching, and let me know your questions below.",
    ].join("\n");
    expect(cleanDescription(raw)).toBe(
      "In this video we take a deep dive into how lithium batteries age, and what you can do about it.\nThanks for watching, and let me know your questions below.",
    );
  });

  test("a line that mentions a time mid-sentence stays", () => {
    expect(cleanDescription("We meet at 7:30 every Tuesday to talk it through.")).toBe("We meet at 7:30 every Tuesday to talk it through.");
  });

  test("word count", () => {
    expect(wordCount(" one  two\nthree ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});
