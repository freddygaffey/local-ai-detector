// Chat-site adapter (docs/plan.md "Chat-site adapters"): on chatgpt.com,
// claude.ai, gemini.google.com, copilot.microsoft.com, perplexity.ai and
// similar sites, score only assistant messages -- never the user's prompt,
// the sidebar, or UI chrome -- with a per-reply score.
//
// Chat UIs change their markup often, so this leans on a generic structural
// heuristic (turn containers, an explicit author-role attribute where one
// exists, an alternation fallback otherwise) rather than brittle per-site
// class names, with ChatGPT's well-documented `data-message-author-role`
// attribute as the one confidently-stable exception. See adapters.test.ts
// for the fixtures this is verified against (real sites weren't scraped for
// this -- their live DOM wasn't available to test against).

import { extractElementText, finalizeAdapterBlock, outermostOnly } from "./dom";
import type { AdapterMatch } from "./types";

const CHAT_HOSTS = [
  /(^|\.)chatgpt\.com$/,
  /(^|\.)chat\.openai\.com$/,
  /(^|\.)claude\.ai$/,
  /(^|\.)gemini\.google\.com$/,
  /(^|\.)copilot\.microsoft\.com$/,
  /(^|\.)perplexity\.ai$/,
];

export function isChatHost(hostname: string): boolean {
  return CHAT_HOSTS.some((re) => re.test(hostname));
}

const TURN_SELECTOR = [
  "[data-message-author-role]",
  '[data-testid*="conversation-turn"]',
  '[data-testid*="chat-message"]',
  '[class*="message-row"]',
  '[class*="chat-message"]',
  '[class*="font-claude-message"]',
  '[class*="model-response"]',
].join(", ");

const ASSISTANT_HINT = /assistant|bot|model|ai-response|chatbot|claude-message/i;
const USER_HINT = /\buser\b|human|prompt-input|user-message/i;

type Role = "assistant" | "user" | null;

function roleOf(el: Element): Role {
  const attr = el.getAttribute("data-message-author-role") ?? el.getAttribute("data-author-role") ?? el.getAttribute("data-role");
  if (attr) {
    if (/assistant|bot|model/i.test(attr)) return "assistant";
    if (/user|human/i.test(attr)) return "user";
  }
  const blob = `${el.className ?? ""} ${el.getAttribute("data-testid") ?? ""}`;
  if (ASSISTANT_HINT.test(blob)) return "assistant";
  if (USER_HINT.test(blob)) return "user";
  return null;
}

const NON_CONTENT_SELECTOR = 'button, [role="button"], form, [contenteditable=""], [contenteditable="true"], time, [class*="avatar" i]';

/** Never throws; returns null when the page doesn't look like a chat conversation. */
export function extractChatAdapter(doc: Document): AdapterMatch | null {
  try {
    const found = Array.from(doc.querySelectorAll(TURN_SELECTOR));
    if (found.length === 0) return null;
    const turns = outermostOnly(found);
    let unresolvedIndex = 0;
    let assistantCount = 0;
    const blocks: AdapterMatch["blocks"] = [];
    for (const el of turns) {
      let role = roleOf(el);
      if (role === null) {
        // Alternation fallback: most of these UIs strictly alternate,
        // starting with the user's first message.
        role = unresolvedIndex % 2 === 0 ? "user" : "assistant";
      }
      unresolvedIndex++;
      if (role !== "assistant") continue;
      assistantCount++;
      const extracted = extractElementText(el, { exclude: (child) => child.matches(NON_CONTENT_SELECTOR) });
      const block = finalizeAdapterBlock("chat", `Reply ${assistantCount}`, "assistant", el, extracted);
      if (block) blocks.push(block);
    }
    if (blocks.length === 0) return null;
    return { site: "chat", blocks };
  } catch {
    return null;
  }
}
