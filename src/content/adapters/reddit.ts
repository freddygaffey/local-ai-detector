// Reddit adapter (docs/plan.md "Comment and thread support"): per-comment
// and per-post scoring for both the current (`shreddit-*` custom elements)
// and old.reddit.com markup. Falls back to the generic comment adapter if
// neither matches (e.g. a Reddit redesign).

import { extractElementText, finalizeAdapterBlock } from "./dom";
import type { AdapterMatch } from "./types";

export function isRedditHost(hostname: string): boolean {
  return /(^|\.)reddit\.com$/.test(hostname);
}

function newRedditBlocks(doc: Document): AdapterMatch["blocks"] {
  const blocks: AdapterMatch["blocks"] = [];
  const post = doc.querySelector("shreddit-post");
  const postBody = post?.querySelector('[slot="text-body"], .md') ?? null;
  if (postBody) {
    const block = finalizeAdapterBlock("reddit-post", "Post", "post", postBody, extractElementText(postBody));
    if (block) blocks.push(block);
  }
  let n = 0;
  for (const comment of Array.from(doc.querySelectorAll("shreddit-comment"))) {
    const body = comment.querySelector('[slot="comment"], .md') ?? comment;
    n++;
    const author = comment.getAttribute("author");
    const label = author ? `Comment by u/${author}` : `Comment ${n}`;
    const block = finalizeAdapterBlock("reddit-comment", label, "comment", body, extractElementText(body));
    if (block) blocks.push(block);
  }
  return blocks;
}

function oldRedditBlocks(doc: Document): AdapterMatch["blocks"] {
  const blocks: AdapterMatch["blocks"] = [];
  const postBody = doc.querySelector(".self .usertext-body .md, .expando .usertext-body .md");
  if (postBody) {
    const block = finalizeAdapterBlock("reddit-post", "Post", "post", postBody, extractElementText(postBody));
    if (block) blocks.push(block);
  }
  let n = 0;
  for (const body of Array.from(doc.querySelectorAll(".comment .usertext-body .md"))) {
    n++;
    const author = body.closest(".comment")?.querySelector(".author")?.textContent?.trim();
    const label = author ? `Comment by ${author}` : `Comment ${n}`;
    const block = finalizeAdapterBlock("reddit-comment", label, "comment", body, extractElementText(body));
    if (block) blocks.push(block);
  }
  return blocks;
}

/** Never throws; returns null when the page has neither Reddit comment structure. */
export function extractRedditAdapter(doc: Document): AdapterMatch | null {
  try {
    const blocks = newRedditBlocks(doc);
    const all = blocks.length > 0 ? blocks : oldRedditBlocks(doc);
    if (all.length === 0) return null;
    return { site: "reddit", blocks: all };
  } catch {
    return null;
  }
}
