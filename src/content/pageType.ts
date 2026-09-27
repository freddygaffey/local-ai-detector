// Page-type classifier: what kind of page this is decides what runs on it
// automatically (src/content/main.ts routes each type to its pipeline).
//
//   article    prose (news, blogs, docs, wikis): page text, Quick then Deep on click
//   thread     forums, Reddit, HN, reviews, comments: per-item scores
//   video      a video is the main content: transcript + voice chips, no page-text score
//   subtitles  raw .srt/.vtt or a caption/transcript viewer: transcript-style scoring
//   search     a results page: snippet markers only
//   app        webmail, editors, dashboards, shops: nothing automatic, only on click
//
// Two layers. URL rules (high confidence) win when they match. Otherwise a
// fingerprint is scored from page signals: structured data (JSON-LD /
// microdata @type), OpenGraph / twitter:card, <meta name="generator">
// platforms, and DOM structure (a dominant player, caption tracks, repeated
// comment items, result lists, prose vs link density, editable app shells,
// timestamped cue lines). The top type wins above a threshold; otherwise
// enough prose means article, and little prose means app.
//
// Pure (DOM in, verdict out): unit-tested against small HTML fixtures
// (pageType.test.ts). A per-site override from settings beats both layers
// (`resolvePageType`).

export type PageType = "article" | "thread" | "video" | "subtitles" | "search" | "app";
export type PageTypeOverride = "auto" | "off" | Exclude<PageType, "app">;

export const PAGE_TYPES: readonly PageType[] = ["article", "thread", "video", "subtitles", "search", "app"];
export const PAGE_TYPE_OVERRIDES: readonly PageTypeOverride[] = ["auto", "article", "thread", "video", "subtitles", "search", "off"];

export interface PageVerdict {
  type: PageType;
  /** Short, human-readable why: "YouTube", "Discourse", "VideoObject + large player". */
  reason: string;
  via: "url" | "fingerprint" | "fallback" | "override";
  /** Only for an "off" override: nothing automatic at all, not even chips. */
  off?: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

// ---- URL rules ---------------------------------------------------------------

type UrlRule = { test: (u: URL) => boolean; type: PageType; reason: string };

const host = (u: URL) => u.hostname.replace(/^www\./, "").toLowerCase();
const onHost = (u: URL, re: RegExp) => re.test(host(u));

const SUBTITLE_EXT = /\.(srt|vtt|sbv|ass|ssa|sub)$/i;

const URL_RULES: UrlRule[] = [
  { test: (u) => SUBTITLE_EXT.test(u.pathname), type: "subtitles", reason: "subtitle file" },

  // Video sites
  { test: (u) => onHost(u, /(^|\.)youtube\.com$/) && /^\/(watch|shorts\/|live\/|embed\/)/.test(u.pathname), type: "video", reason: "YouTube" },
  { test: (u) => onHost(u, /(^|\.)youtube\.com$/) && u.pathname === "/results", type: "search", reason: "YouTube search" },
  { test: (u) => onHost(u, /^(m\.)?youtube\.com$/), type: "app", reason: "YouTube" },
  { test: (u) => onHost(u, /(^|\.)vimeo\.com$/) && /^\/(video\/)?\d+/.test(u.pathname), type: "video", reason: "Vimeo" },
  { test: (u) => onHost(u, /(^|\.)twitch\.tv$/) && (/^\/videos\/\d+/.test(u.pathname) || /\/clip\//.test(u.pathname) || host(u).startsWith("clips.")), type: "video", reason: "Twitch" },
  { test: (u) => onHost(u, /(^|\.)twitch\.tv$/) && /^\/[\w-]+\/?$/.test(u.pathname) && !/^\/(directory|search|settings|downloads|jobs|p)\/?$/.test(u.pathname), type: "video", reason: "Twitch" },
  { test: (u) => onHost(u, /(^|\.)dailymotion\.com$/) && u.pathname.startsWith("/video/"), type: "video", reason: "Dailymotion" },
  { test: (u) => onHost(u, /(^|\.)tiktok\.com$/) && /\/video\/\d+/.test(u.pathname), type: "video", reason: "TikTok" },
  { test: (u) => onHost(u, /(^|\.)ted\.com$/) && u.pathname.startsWith("/talks/"), type: "video", reason: "TED" },
  { test: (u) => onHost(u, /(^|\.)(rumble\.com|odysee\.com|bilibili\.com|nebula\.tv)$/) && u.pathname.length > 1, type: "video", reason: "video site" },

  // Threads
  { test: (u) => onHost(u, /(^|\.)reddit\.com$/), type: "thread", reason: "Reddit" },
  { test: (u) => onHost(u, /^news\.ycombinator\.com$/), type: "thread", reason: "Hacker News" },
  { test: (u) => onHost(u, /(^|\.)(stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|askubuntu\.com|mathoverflow\.net)$/) && /^\/(questions|q|a)\/\d+/.test(u.pathname), type: "thread", reason: "Stack Exchange" },
  { test: (u) => onHost(u, /^(x|twitter|mobile\.twitter)\.com$/), type: "thread", reason: "X" },
  { test: (u) => onHost(u, /(^|\.)(bsky\.app|threads\.net|threads\.com)$/), type: "thread", reason: "social" },
  { test: (u) => /^\/@[\w.-]+\/\d{6,}/.test(u.pathname) && onHost(u, /(^|\.)(mastodon\.[a-z.]+|mstdn\.[a-z.]+|[\w-]+\.social|fosstodon\.org|hachyderm\.io|infosec\.exchange)$/), type: "thread", reason: "Mastodon" },
  { test: (u) => /^\/(post|comment)\/\d+/.test(u.pathname) && onHost(u, /(^|\.)(lemmy\.[a-z.]+|lemm\.ee|sh\.itjust\.works|beehaw\.org|feddit\.[a-z.]+|programming\.dev)$/), type: "thread", reason: "Lemmy" },
  { test: (u) => onHost(u, /(^|\.)quora\.com$/), type: "thread", reason: "Quora" },
  { test: (u) => onHost(u, /^lobste\.rs$/), type: "thread", reason: "Lobsters" },
  { test: (u) => onHost(u, /^(github\.com|gitlab\.com)$/) && /\/(issues|pull|merge_requests|discussions)\/\d+/.test(u.pathname), type: "thread", reason: "issue thread" },
  { test: (u) => onHost(u, /(^|\.)amazon\.[a-z.]+$/) && /\/product-reviews\//.test(u.pathname), type: "thread", reason: "reviews" },
  // Product pages: the full review list now needs a login, so the reviews
  // shown on the product page are what a logged-out reader sees. Scored as
  // a thread (one score per review; the listing copy isn't scored).
  { test: (u) => onHost(u, /(^|\.)amazon\.[a-z.]+$/) && /\/(dp|gp\/product)\/[A-Z0-9]{10}/.test(u.pathname), type: "thread", reason: "reviews" },

  // Search
  { test: (u) => onHost(u, /(^|\.)google\.[a-z.]+$/) && u.pathname === "/search", type: "search", reason: "Google" },
  { test: (u) => onHost(u, /(^|\.)bing\.com$/) && u.pathname === "/search", type: "search", reason: "Bing" },
  { test: (u) => onHost(u, /(^|\.)duckduckgo\.com$/) && (u.searchParams.has("q") || u.pathname.startsWith("/html")), type: "search", reason: "DuckDuckGo" },
  { test: (u) => onHost(u, /(^|\.)kagi\.com$/) && u.pathname === "/search", type: "search", reason: "Kagi" },
  { test: (u) => onHost(u, /^search\.brave\.com$/) && u.pathname === "/search", type: "search", reason: "Brave Search" },
  { test: (u) => onHost(u, /(^|\.)(search\.yahoo\.com|ecosia\.org|startpage\.com|qwant\.com)$/) && /search|^\/$|\/sp\//.test(u.pathname) && (u.searchParams.has("q") || u.searchParams.has("p") || u.searchParams.has("query")), type: "search", reason: "search engine" },

  // Apps
  { test: (u) => onHost(u, /^(mail|calendar|drive|docs|sheets|slides|keep|photos|meet|chat|contacts|maps)\.google\.com$/), type: "app", reason: "Google app" },
  { test: (u) => onHost(u, /(^|\.)(outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com|office\.com|sharepoint\.com|onedrive\.live\.com)$/), type: "app", reason: "Microsoft app" },
  { test: (u) => onHost(u, /(^|\.)(notion\.so|figma\.com|canva\.com|miro\.com|linear\.app|trello\.com|asana\.com|airtable\.com|slack\.com|discord\.com|web\.whatsapp\.com|web\.telegram\.org|mail\.proton\.me|app\.fastmail\.com|icloud\.com|overleaf\.com|codepen\.io|replit\.com|vercel\.com|netlify\.com|console\.aws\.amazon\.com|portal\.azure\.com|console\.cloud\.google\.com)$/), type: "app", reason: "web app" },
  { test: (u) => onHost(u, /^(github\.com|gitlab\.com|bitbucket\.org)$/), type: "app", reason: "code host" },
  { test: (u) => onHost(u, /(^|\.)(amazon\.[a-z.]+|ebay\.[a-z.]+|etsy\.com|aliexpress\.com|walmart\.com|temu\.com)$/), type: "app", reason: "shop" },
];

export function classifyUrl(href: string): PageVerdict | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/^https?:|^file:/.test(u.protocol)) return null;
  for (const r of URL_RULES) {
    try {
      if (r.test(u)) return { type: r.type, reason: r.reason, via: "url" };
    } catch {
      // next rule
    }
  }
  return null;
}

// ---- Fingerprint ---------------------------------------------------------------

type Scores = Record<PageType, { score: number; why: string[] }>;

function emptyScores(): Scores {
  const s = {} as Scores;
  for (const t of PAGE_TYPES) s[t] = { score: 0, why: [] };
  return s;
}

function add(s: Scores, t: PageType, pts: number, why: string): void {
  s[t].score += pts;
  if (!s[t].why.includes(why)) s[t].why.push(why);
}

/** JSON-LD and microdata @type values on the page (flattened, @graph included). */
export function structuredTypes(doc: Document): string[] {
  const out = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string") out.add(v.replace(/^.*[/#]/, ""));
    if (o["@graph"]) visit(o["@graph"], depth + 1);
    if (o.mainEntity) visit(o.mainEntity, depth + 1);
  };
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(s.textContent ?? ""), 0);
    } catch {
      // malformed JSON-LD is common; skip it
    }
  }
  for (const el of Array.from(doc.querySelectorAll("[itemtype]")).slice(0, 50)) {
    for (const t of (el.getAttribute("itemtype") ?? "").split(/\s+/)) if (t) out.add(t.replace(/^.*[/#]/, ""));
  }
  return [...out];
}

function meta(doc: Document, key: string): string {
  const el = doc.querySelector(`meta[property="${key}"], meta[name="${key}"]`);
  return (el?.getAttribute("content") ?? "").trim();
}

const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|Report|TechArticle|ScholarlyArticle|AnalysisNewsArticle|OpinionNewsArticle|ReviewNewsArticle|LiveBlogPosting|Recipe|HowTo)$/;
const THREAD_TYPES = /^(DiscussionForumPosting|QAPage|Question|SocialMediaPosting|Comment|Answer)$/;
const APP_TYPES = /^(WebApplication|SoftwareApplication|Product|ProductGroup|Offer|AggregateOffer)$/;

const THREAD_GENERATORS: [RegExp, string][] = [
  [/discourse/i, "Discourse"],
  [/phpbb/i, "phpBB"],
  [/vbulletin/i, "vBulletin"],
  [/xenforo/i, "XenForo"],
  [/lemmy/i, "Lemmy"],
  [/flarum/i, "Flarum"],
  [/nodebb/i, "NodeBB"],
  [/mybb/i, "MyBB"],
  [/invision|ips community/i, "Invision"],
  [/mastodon/i, "Mastodon"],
];
const ARTICLE_GENERATORS: [RegExp, string][] = [
  [/wordpress/i, "WordPress"],
  [/ghost/i, "Ghost"],
  [/substack/i, "Substack"],
  [/medium/i, "Medium"],
  [/mediawiki/i, "MediaWiki"],
  [/hugo/i, "Hugo"],
  [/jekyll/i, "Jekyll"],
  [/blogger/i, "Blogger"],
  [/docusaurus|mkdocs|sphinx|gitbook|hashnode|write\.as|bear blog/i, "docs/blog"],
];

function words(text: string): number {
  return text.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;
}

function elSize(el: Element): { w: number; h: number } {
  const r = (el as HTMLElement).getBoundingClientRect?.();
  let w = r?.width ?? 0;
  let h = r?.height ?? 0;
  if (!w || !h) {
    w = Number(el.getAttribute("width")) || 0;
    h = Number(el.getAttribute("height")) || (w ? w * 0.5625 : 0);
  }
  return { w, h };
}

const PLAYER_IFRAME = /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|player\.twitch\.tv|dailymotion\.com\/embed|jwplayer|brightcove|wistia|vidyard|loom\.com\/embed/i;

/** The largest video or embedded player, as a share of the viewport. */
export function dominantPlayer(doc: Document, vp: Viewport): { share: number; widthShare: number; el: Element | null } {
  let best = { share: 0, widthShare: 0, el: null as Element | null };
  const candidates = [
    ...Array.from(doc.querySelectorAll("video")),
    ...Array.from(doc.querySelectorAll("iframe")).filter((f) => PLAYER_IFRAME.test(f.getAttribute("src") ?? "")),
  ];
  for (const el of candidates) {
    const { w, h } = elSize(el);
    const share = (Math.min(w, vp.width) * Math.min(h, vp.height)) / Math.max(1, vp.width * vp.height);
    if (share > best.share) best = { share, widthShare: Math.min(1, w / Math.max(1, vp.width)), el };
  }
  return best;
}

const CUE_LINE = /(?:^|\s)(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{2,3}/gm;
const STAMP_LINE = /^\s*\[?\(?(\d{1,2}:)?\d{1,2}:\d{2}\)?\]?\s+\S/gm;

/** Timestamped cue lines in the page's own text (SRT/VTT or "0:12 text" transcripts). */
export function cueLineCount(text: string): { arrows: number; stamps: number } {
  return { arrows: (text.match(CUE_LINE) ?? []).length, stamps: (text.match(STAMP_LINE) ?? []).length };
}

const AUTHORISH = '[class*="author" i], [class*="user" i], [class*="byline" i], [rel="author"], [itemprop="author"], [data-testid*="author" i], a[href*="/user/"], a[href*="/u/"], a[href*="/members/"], a[href*="/profile"]';
const TIMEISH = 'time, [datetime], [class*="date" i], [class*="time" i], [class*="ago" i]';

/** Largest group of same-shaped siblings that each look like a post: author + timestamp + some text. */
export function repeatedPostCount(doc: Document): number {
  let best = 0;
  const seen = new Set<Element>();
  const marks = Array.from(doc.querySelectorAll(TIMEISH)).slice(0, 400);
  for (const m of marks) {
    // Walk up to the element that repeats (has >= 3 same-shaped siblings).
    let el: Element | null = m;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      const parent: Element | null = el.parentElement;
      if (!parent || seen.has(parent)) continue;
      const sig = (e: Element) => `${e.tagName}|${(e.getAttribute("class") ?? "").split(/\s+/).filter((c) => !/\d/.test(c)).sort().join(".")}`;
      const mySig = sig(el);
      const sibs = Array.from(parent.children).filter((c) => sig(c) === mySig);
      if (sibs.length < 3) continue;
      seen.add(parent);
      const posts = sibs.filter((s) => s.querySelector(AUTHORISH) && s.querySelector(TIMEISH) && words(s.textContent ?? "") >= 8);
      best = Math.max(best, posts.length);
      break;
    }
  }
  // Explicit comment markup counts too (itemtype Comment, comment ids/classes).
  const explicit = doc.querySelectorAll('[itemtype*="Comment"], [id^="comment-"], [class~="comment"], [data-testid="comment"], shreddit-comment, article[data-testid="tweet"]').length;
  return Math.max(best, explicit);
}

/** Result-list items: repeated blocks each with a heading link and a short snippet. */
export function resultListCount(doc: Document): number {
  let best = 0;
  for (const list of Array.from(doc.querySelectorAll("ol, ul, main, [role=main], #results, #search, .results, div")).slice(0, 600)) {
    const items = Array.from(list.children).filter((c) => {
      const a = c.querySelector("h2 a[href], h3 a[href], a[href] h2, a[href] h3");
      if (!a) return false;
      const n = words(c.textContent ?? "");
      return n >= 8 && n <= 120;
    });
    best = Math.max(best, items.length);
  }
  return best;
}

/** Prose: words in paragraphs (not inside links), and the page's link density. */
export function proseStats(doc: Document): { proseWords: number; linkDensity: number } {
  const root = doc.querySelector("article") ?? doc.querySelector("main, [role=main]") ?? doc.body;
  if (!root) return { proseWords: 0, linkDensity: 1 };
  let prose = 0;
  for (const p of Array.from(root.querySelectorAll("p, blockquote, li > p, dd"))) {
    if (p.closest("nav, header, footer, aside, [role=navigation], form")) continue;
    const t = p.textContent ?? "";
    const link = Array.from(p.querySelectorAll("a")).reduce((n, a) => n + (a.textContent ?? "").length, 0);
    if (t.length < 40 || link / Math.max(1, t.length) > 0.5) continue;
    prose += words(t);
  }
  // Older hand-made pages set text straight into a <td>/<font>/<div>
  // separated by <br>s, with no <p> at all (e.g. paulgraham.com essays).
  // Count such bare sentence text too.
  if (prose < 250) prose += bareTextWords(root);
  const all = (doc.body?.textContent ?? "").length;
  const links = Array.from(doc.querySelectorAll("a")).reduce((n, a) => n + (a.textContent ?? "").length, 0);
  return { proseWords: prose, linkDensity: all ? links / all : 1 };
}

/** Words in text nodes sitting directly in a non-paragraph element, where that element holds sentence prose (>= 40 words, several full stops). */
function bareTextWords(root: Element): number {
  let total = 0;
  const els = root.querySelectorAll("div, td, font, section, span, center, body");
  for (let i = 0; i < els.length && i < 4000; i++) {
    const el = els[i]!;
    if (el.closest("nav, header, footer, aside, [role=navigation], form, p, li, a, script, style")) continue;
    let text = "";
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) text += ` ${n.textContent ?? ""}`;
    const w = words(text);
    if (w >= 40 && (text.match(/[.!?](\s|$)/g)?.length ?? 0) >= 3) total += w;
  }
  return total;
}

function appShell(doc: Document): boolean {
  const editable = Array.from(doc.querySelectorAll('[contenteditable=""], [contenteditable="true"], [role="textbox"]')).some((e) => {
    const { w, h } = elSize(e);
    return (w >= 300 && h >= 150) || e.closest('[role="application"], [role="main"]') !== null;
  });
  return editable || doc.querySelector('[role="application"], [role="grid"], [role="treegrid"]') !== null;
}

export interface FingerprintInput {
  doc: Document;
  url: string;
  viewport: Viewport;
}

/** Fingerprint-only classification (no URL rules). */
export function fingerprintPage({ doc, url, viewport }: FingerprintInput): PageVerdict {
  const s = emptyScores();

  // Raw subtitle / transcript text (a .srt served as text/plain, a caption viewer).
  const bodyText = (doc.body?.textContent ?? "").slice(0, 200_000);
  const cues = cueLineCount(bodyText);
  if (/^\s*WEBVTT/.test(bodyText)) add(s, "subtitles", 6, "WEBVTT");
  if (cues.arrows >= 3) add(s, "subtitles", 6, "cue timestamps");
  else if (cues.stamps >= 12 && cues.stamps * 6 >= bodyText.split("\n").filter((l) => l.trim()).length) add(s, "subtitles", 4, "timestamped lines");

  // Structured data
  const types = structuredTypes(doc);
  for (const t of types) {
    if (ARTICLE_TYPES.test(t)) add(s, "article", 3, t);
    else if (THREAD_TYPES.test(t)) add(s, "thread", 3.5, t);
    else if (t === "VideoObject") add(s, "video", 2, t);
    else if (t === "SearchResultsPage") add(s, "search", 4, t);
    else if (APP_TYPES.test(t)) add(s, "app", 2.5, t);
  }

  // OpenGraph / Twitter
  const og = meta(doc, "og:type").toLowerCase();
  if (og === "article") add(s, "article", 2, "og:article");
  else if (og.startsWith("video")) add(s, "video", 2, `og:${og}`);
  else if (og === "product" || og.startsWith("product.")) add(s, "app", 2, "og:product");
  if (meta(doc, "twitter:card").toLowerCase() === "player") add(s, "video", 1, "twitter:player");

  // Platform
  const gen = meta(doc, "generator");
  if (gen) {
    const th = THREAD_GENERATORS.find(([re]) => re.test(gen));
    const ar = ARTICLE_GENERATORS.find(([re]) => re.test(gen));
    if (th) add(s, "thread", 4, th[1]);
    else if (ar) add(s, "article", 1.5, ar[1]);
  }

  // Dominant player
  const player = dominantPlayer(doc, viewport);
  if (player.share >= 0.3 || player.widthShare >= 0.6) add(s, "video", 3, "large player");
  else if (player.share >= 0.12) add(s, "video", 1, "player");
  if (doc.querySelector('video track[kind="captions"], video track[kind="subtitles"], video track:not([kind])')) add(s, "video", 1, "caption track");

  // Repeated posts / comments
  const posts = repeatedPostCount(doc);
  if (posts >= 5) add(s, "thread", 3, "repeated posts");
  else if (posts >= 3) add(s, "thread", 1.5, "repeated posts");

  // Result list + a filled search box
  const q = Array.from(doc.querySelectorAll<HTMLInputElement>('input[type="search"], input[name="q"], input[name="query"], input[name="search"]')).some((i) => (i.value ?? i.getAttribute("value") ?? "").trim().length > 0);
  const results = resultListCount(doc);
  if (results >= 5 && q) add(s, "search", 3.5, "result list");
  else if (results >= 5 && /[?&](q|query|search|s)=/.test(url)) add(s, "search", 3, "result list");

  // Prose vs links, app shells
  const prose = proseStats(doc);
  if (prose.proseWords >= 250 && prose.linkDensity < 0.35) add(s, "article", 2, "prose");
  else if (prose.proseWords >= 120) add(s, "article", 1, "prose");
  if (appShell(doc)) add(s, "app", 2.5, "editable app shell");
  if (prose.proseWords < 60) add(s, "app", 0.5, "little prose");

  // A video page usually also carries a paragraph of description: don't let
  // that make it an article, and don't let a comment section under an
  // article make the article a thread.
  if (s.video.score >= 3 && prose.proseWords < 400) s.article.score -= 1;
  if (s.article.score >= 4 && s.thread.why.every((w) => w === "repeated posts")) s.thread.score -= 1.5;

  const ranked = PAGE_TYPES.map((t) => ({ t, ...s[t] })).sort((a, b) => b.score - a.score);
  const top = ranked[0]!;
  if (top.score >= 3) return { type: top.t, reason: top.why.slice(0, 2).join(" + "), via: "fingerprint" };
  if (prose.proseWords >= 120) return { type: "article", reason: "prose", via: "fallback" };
  return { type: "app", reason: "little prose", via: "fallback" };
}

/** URL rules first; the fingerprint for everything else. */
export function classifyPage(input: FingerprintInput): PageVerdict {
  return classifyUrl(input.url) ?? fingerprintPage(input);
}

/** Applies a per-site override ("auto" = none) to a classification. */
export function resolvePageType(verdict: PageVerdict, override: PageTypeOverride | undefined): PageVerdict {
  if (!override || override === "auto") return verdict;
  if (override === "off") return { type: "app", reason: "off on this site", via: "override", off: true };
  return { type: override, reason: "set for this site", via: "override" };
}

/** "Page: video (YouTube)" -- the quiet one-liner for popup Details. */
export function describeVerdict(v: PageVerdict): string {
  return v.off ? "Page: off on this site" : `Page: ${v.type} (${v.reason})`;
}
