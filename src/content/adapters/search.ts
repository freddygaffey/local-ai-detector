// Search-result adapter (docs/plan.md "Slop filter"): a small marker on
// flagged results on Google, Bing, DuckDuckGo and Kagi. Scores only the
// snippet text already rendered on the results page -- it never fetches the
// linked page (deliberately out of scope; see docs/plan.md "Deliberately
// excluded: analyze linked page").

import { extractElementText, finalizeAdapterBlock, outermostOnly } from "./dom";
import type { AdapterMatch } from "./types";

export type SearchEngine = "google" | "bing" | "duckduckgo" | "kagi";

const SEARCH_HOSTS: [RegExp, SearchEngine][] = [
  [/(^|\.)google\.[a-z.]+$/, "google"],
  [/(^|\.)bing\.com$/, "bing"],
  [/(^|\.)duckduckgo\.com$/, "duckduckgo"],
  [/(^|\.)kagi\.com$/, "kagi"],
];

export function searchEngineForHost(hostname: string): SearchEngine | null {
  for (const [re, engine] of SEARCH_HOSTS) {
    if (re.test(hostname)) return engine;
  }
  return null;
}

const RESULT_SELECTOR: Record<SearchEngine, string> = {
  google: "#search .g, #rso > div",
  bing: "li.b_algo",
  duckduckgo: 'article[data-testid="result"], .result',
  kagi: ".search-result, .result",
};

const SNIPPET_SELECTOR = '[class*="snippet" i], [data-testid="result-snippet"], [data-result="snippet"], .b_caption, .VwiC3b, .st';

const MIN_SNIPPET_WORDS = 8;

/** Never throws; returns null when the host isn't a supported search engine or has no results yet. */
export function extractSearchResultsAdapter(doc: Document, hostname: string): AdapterMatch | null {
  try {
    const engine = searchEngineForHost(hostname);
    if (!engine) return null;
    let found = Array.from(doc.querySelectorAll(RESULT_SELECTOR[engine]));
    if (engine === "google") {
      // Google's result wrappers change often (".g" is gone; "#rso > div" is
      // now a couple of section wrappers holding every result). Anchor on the
      // snippets themselves and take each one's own result container.
      const perSnippet = Array.from(doc.querySelectorAll("#rso .VwiC3b, #rso [data-sncf]"))
        .map((sn) => sn.closest(".MjjYud, .g, [data-hveid]"))
        .filter((el): el is Element => el !== null);
      if (perSnippet.length > found.length) found = [...new Set(perSnippet)];
    }
    if (found.length === 0) return null;
    const items = outermostOnly(found);
    let n = 0;
    const blocks: AdapterMatch["blocks"] = [];
    for (const node of items) {
      const snippet = node.querySelector(SNIPPET_SELECTOR) ?? node;
      n++;
      const extracted = extractElementText(snippet, {
        exclude: (el) => el.tagName === "CITE" || el.tagName === "A",
      });
      const block = finalizeAdapterBlock("result", `Result ${n}`, "result", node, extracted);
      if (block && block.text.trim().split(/\s+/).length >= MIN_SNIPPET_WORDS) blocks.push(block);
    }
    if (blocks.length === 0) return null;
    return { site: `search-${engine}`, blocks };
  } catch {
    return null;
  }
}
