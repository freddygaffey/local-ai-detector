// @vitest-environment happy-dom
//
// Fixture-based tests for the chat, Reddit, generic-comment and search
// adapters. Real chat/Reddit/search DOMs weren't available to test against
// (no network fetch from an agent), so these fixtures approximate documented
// structure (ChatGPT's `data-message-author-role`, Reddit's `shreddit-*`
// custom elements and old.reddit.com markup) -- see the "known limitations"
// note in the final report for what that means for accuracy on a real site.

import { describe, expect, test } from "vitest";
import { extractChatAdapter, isChatHost } from "./chat";
import { extractGenericCommentsAdapter, isBlockTooShort } from "./comments";
import { extractRedditAdapter, isRedditHost } from "./reddit";
import { extractSearchResultsAdapter, searchEngineForHost } from "./search";
import { detectStructuredContent } from "./index";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("isChatHost / isRedditHost / searchEngineForHost", () => {
  test("recognizes the listed chat sites", () => {
    for (const host of ["chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "copilot.microsoft.com", "perplexity.ai"]) {
      expect(isChatHost(host)).toBe(true);
    }
    expect(isChatHost("example.com")).toBe(false);
  });
  test("recognizes reddit.com and subdomains", () => {
    expect(isRedditHost("www.reddit.com")).toBe(true);
    expect(isRedditHost("old.reddit.com")).toBe(true);
    expect(isRedditHost("reddit.co")).toBe(false);
  });
  test("recognizes the four search engines", () => {
    expect(searchEngineForHost("www.google.com")).toBe("google");
    expect(searchEngineForHost("www.bing.com")).toBe("bing");
    expect(searchEngineForHost("duckduckgo.com")).toBe("duckduckgo");
    expect(searchEngineForHost("kagi.com")).toBe("kagi");
    expect(searchEngineForHost("example.com")).toBeNull();
  });
});

const LONG_SENTENCE = "This is a reasonably long sentence with plenty of words in it so segmentation and word counts behave.";

describe("extractChatAdapter", () => {
  test("scores only assistant turns (ChatGPT-style data-message-author-role)", () => {
    setBody(`
      <main>
        <div data-message-author-role="user"><div>What is the capital of France?</div></div>
        <div data-message-author-role="assistant"><div class="markdown">${LONG_SENTENCE} Paris is the capital of France.</div></div>
        <div data-message-author-role="user"><div>Thanks!</div></div>
        <div data-message-author-role="assistant"><div class="markdown">${LONG_SENTENCE} You are welcome.</div></div>
      </main>
    `);
    const result = extractChatAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(2);
    expect(result!.blocks[0]!.label).toBe("Reply 1");
    expect(result!.blocks.every((b) => b.kind === "assistant")).toBe(true);
    expect(result!.blocks.some((b) => b.text.includes("capital of France"))).toBe(true);
    expect(result!.blocks.some((b) => b.text.includes("Thanks"))).toBe(false);
  });

  test("excludes buttons and other non-content chrome inside a turn", () => {
    setBody(`
      <main>
        <div data-message-author-role="assistant">
          <div class="markdown">${LONG_SENTENCE}</div>
          <button>Copy</button>
          <button>Regenerate</button>
        </div>
      </main>
    `);
    const result = extractChatAdapter(document);
    expect(result!.blocks[0]!.text).not.toMatch(/Copy|Regenerate/);
  });

  test("falls back to class-based role hints (Claude-like markup)", () => {
    setBody(`
      <main>
        <div class="human-turn">What is 2+2?</div>
        <div class="font-claude-message">${LONG_SENTENCE} The answer is four.</div>
      </main>
    `);
    const result = extractChatAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]!.text).toContain("answer is four");
  });

  test("returns null on an ordinary page", () => {
    setBody(`<main><article><p>${LONG_SENTENCE}</p></article></main>`);
    expect(extractChatAdapter(document)).toBeNull();
  });
});

describe("extractRedditAdapter", () => {
  test("new Reddit: shreddit-post + shreddit-comment", () => {
    setBody(`
      <shreddit-post>
        <div slot="text-body" class="md"><p>${LONG_SENTENCE} This is my post.</p></div>
      </shreddit-post>
      <shreddit-comment author="alice">
        <div slot="comment" class="md"><p>${LONG_SENTENCE} Great point, alice here.</p></div>
      </shreddit-comment>
      <shreddit-comment author="bob">
        <div slot="comment" class="md"><p>${LONG_SENTENCE} I disagree, says bob.</p></div>
      </shreddit-comment>
    `);
    const result = extractRedditAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks.map((b) => b.kind)).toEqual(["post", "comment", "comment"]);
    expect(result!.blocks[1]!.label).toBe("Comment by u/alice");
    expect(result!.blocks[2]!.label).toBe("Comment by u/bob");
  });

  test("old.reddit.com markup", () => {
    setBody(`
      <div class="comment">
        <div class="entry">
          <p class="tagline"><a class="author">carol</a></p>
          <div class="usertext-body"><div class="md"><p>${LONG_SENTENCE} Old reddit comment text.</p></div></div>
        </div>
      </div>
    `);
    const result = extractRedditAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks[0]!.label).toBe("Comment by carol");
    expect(result!.blocks[0]!.text).toContain("Old reddit comment");
  });

  test("returns null when neither Reddit shape is present", () => {
    setBody(`<main><p>${LONG_SENTENCE}</p></main>`);
    expect(extractRedditAdapter(document)).toBeNull();
  });
});

describe("extractGenericCommentsAdapter", () => {
  test("Hacker News-style .commtext rows", () => {
    setBody(`
      <table>
        <tr class="athing comtr"><td><div class="commtext c00">${LONG_SENTENCE} First HN comment.</div></td></tr>
        <tr class="athing comtr"><td><div class="commtext c00">${LONG_SENTENCE} Second HN comment.</div></td></tr>
      </table>
    `);
    const result = extractGenericCommentsAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(2);
  });

  test("Stack Exchange answers, not just the comments under them", () => {
    setBody(`
      <div class="question"><div class="s-prose js-post-body">${LONG_SENTENCE} The question.</div>
        <div class="comments"><span class="comment-copy">Short comment.</span></div></div>
      <div class="answer"><div class="s-prose js-post-body">${LONG_SENTENCE} First answer.</div></div>
      <div class="answer"><div class="s-prose js-post-body">${LONG_SENTENCE} Second answer.</div></div>
    `);
    const result = extractGenericCommentsAdapter(document);
    expect(result!.blocks.filter((b) => /answer|question/.test(b.text))).toHaveLength(3);
  });

  test("Discourse posts", () => {
    setBody(`
      <article class="topic-post"><div class="cooked"><p>${LONG_SENTENCE} First post.</p></div></article>
      <article class="topic-post"><div class="cooked"><p>${LONG_SENTENCE} A reply.</p></div></article>
    `);
    expect(extractGenericCommentsAdapter(document)!.blocks).toHaveLength(2);
  });

  test("generic forum/review markup", () => {
    setBody(`
      <div class="review"><div class="review-body">${LONG_SENTENCE} This product is great.</div></div>
      <div class="review"><div class="review-body">${LONG_SENTENCE} Would not buy again.</div></div>
    `);
    const result = extractGenericCommentsAdapter(document);
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(2);
  });

  test("returns null on an ordinary article page", () => {
    setBody(`<main><article><p>${LONG_SENTENCE}</p></article></main>`);
    expect(extractGenericCommentsAdapter(document)).toBeNull();
  });
});

describe("isBlockTooShort", () => {
  test("under minWords is too short", () => {
    expect(isBlockTooShort("too short", 50)).toBe(true);
  });
  test("at/above minWords is not", () => {
    expect(isBlockTooShort(LONG_SENTENCE.repeat(5), 20)).toBe(false);
  });
});

describe("extractSearchResultsAdapter", () => {
  test("Google-like result markup", () => {
    setBody(`
      <div id="search">
        <div class="g">
          <h3><a href="https://example.com">Example result</a></h3>
          <div class="VwiC3b">${LONG_SENTENCE} A helpful snippet about the topic.</div>
        </div>
      </div>
    `);
    const result = extractSearchResultsAdapter(document, "www.google.com");
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]!.text).toContain("helpful snippet");
  });

  test("short snippets are dropped", () => {
    setBody(`<div id="search"><div class="g"><div class="VwiC3b">Too short.</div></div></div>`);
    expect(extractSearchResultsAdapter(document, "www.google.com")).toBeNull();
  });

  test("returns null on a non-search host", () => {
    setBody(`<div id="search"><div class="g"><div class="VwiC3b">${LONG_SENTENCE}</div></div></div>`);
    expect(extractSearchResultsAdapter(document, "example.com")).toBeNull();
  });
});

describe("detectStructuredContent", () => {
  test("prefers the chat adapter on a chat host", () => {
    setBody(`
      <main><div data-message-author-role="assistant"><div>${LONG_SENTENCE}</div></div></main>
    `);
    const result = detectStructuredContent(document, "chatgpt.com");
    expect(result?.site).toBe("chat");
  });

  test("falls back to generic comments on a non-adapter host with comment markup", () => {
    setBody(`<div class="comment-body">${LONG_SENTENCE}</div>`);
    const result = detectStructuredContent(document, "some-forum.example");
    expect(result?.site).toBe("generic-comments");
  });

  test("returns null for a plain article page", () => {
    setBody(`<main><article><p>${LONG_SENTENCE}</p></article></main>`);
    expect(detectStructuredContent(document, "news.example")).toBeNull();
  });
});
