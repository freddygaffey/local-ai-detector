// @vitest-environment happy-dom
import { describe, expect, test } from "vitest";
import { classifyPage, classifyUrl, cueLineCount, describeVerdict, fingerprintPage, resolvePageType, structuredTypes } from "./pageType";

const VP = { width: 1280, height: 800 };

function doc(html: string): Document {
  const d = document.implementation.createHTMLDocument("t");
  d.documentElement.innerHTML = html;
  return d;
}

const para = (n: number, w = "the quick brown fox jumps over a lazy dog while writers keep writing prose") =>
  Array.from({ length: n }, () => `<p>${w} ${w}. ${w}.</p>`).join("");

describe("URL rules", () => {
  test.each([
    ["https://www.youtube.com/watch?v=abc123def45", "video", "YouTube"],
    ["https://www.youtube.com/shorts/abc123def45", "video", "YouTube"],
    ["https://www.youtube.com/", "app", "YouTube"],
    ["https://vimeo.com/76979871", "video", "Vimeo"],
    ["https://www.twitch.tv/videos/123456", "video", "Twitch"],
    ["https://www.reddit.com/r/test/comments/abc/title/", "thread", "Reddit"],
    ["https://news.ycombinator.com/item?id=1", "thread", "Hacker News"],
    ["https://stackoverflow.com/questions/123/how", "thread", "Stack Exchange"],
    ["https://x.com/someone/status/1234", "thread", "X"],
    ["https://mastodon.social/@user/112233445566", "thread", "Mastodon"],
    ["https://lemmy.world/post/12345", "thread", "Lemmy"],
    ["https://www.google.com/search?q=cats", "search", "Google"],
    ["https://www.bing.com/search?q=cats", "search", "Bing"],
    ["https://duckduckgo.com/?q=cats", "search", "DuckDuckGo"],
    ["https://kagi.com/search?q=cats", "search", "Kagi"],
    ["https://mail.google.com/mail/u/0/#inbox", "app", "Google app"],
    ["https://docs.google.com/document/d/x/edit", "app", "Google app"],
    ["https://www.notion.so/page", "app", "web app"],
    ["https://github.com/owner/repo", "app", "code host"],
    ["https://github.com/owner/repo/issues/12", "thread", "issue thread"],
    ["https://www.amazon.com/Anker-Cable/dp/B088NRLMPV/ref=sr_1_3", "thread", "reviews"],
    ["https://www.amazon.com.au/s?k=cable", "app", "shop"],
    ["https://chatgpt.com/share/6a951619-1c34-83ec-8628-8d4061b5e4ad", "thread", "shared chat"],
    ["https://claude.ai/share/0b1c2d3e-aaaa-bbbb-cccc-000000000000", "thread", "shared chat"],
    ["https://chatgpt.com/c/abc", "app", "chat app"],
    ["https://example.com/subs/movie.en.srt", "subtitles", "subtitle file"],
    ["https://example.com/captions.vtt", "subtitles", "subtitle file"],
  ])("%s -> %s", (url, type, reason) => {
    expect(classifyUrl(url)).toEqual({ type, reason, via: "url" });
  });

  test("no rule for an ordinary site", () => {
    expect(classifyUrl("https://example.com/blog/post")).toBeNull();
    expect(classifyUrl("chrome://extensions")).toBeNull();
  });
});

describe("fingerprint", () => {
  const url = "https://example.com/x";

  test("news article via JSON-LD + og:type + prose", () => {
    const d = doc(`<head><meta property="og:type" content="article">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"x"}</script></head>
      <body><nav><a href="/">Home</a></nav><article><h1>Title</h1>${para(8)}</article></body>`);
    const v = fingerprintPage({ doc: d, url, viewport: VP });
    expect(v.type).toBe("article");
    expect(v.reason).toContain("NewsArticle");
  });

  test("@graph JSON-LD is flattened", () => {
    const d = doc(`<head><script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["BlogPosting"]}]}</script></head><body></body>`);
    expect(structuredTypes(d)).toEqual(expect.arrayContaining(["WebPage", "BlogPosting"]));
  });

  test("an essay set in a table cell with <br>s and no <p> is an article (paulgraham.com)", () => {
    const sent = "The way to do great work is to find something you are curious about and then keep working at it for years. ";
    const body = Array.from({ length: 12 }, () => sent.repeat(3)).join("<br><br>");
    const d = doc(`<body><table><tr><td><font size="2" face="verdana">${body}</font></td></tr></table></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("article");
  });

  test("Discourse forum via generator", () => {
    const d = doc(`<head><meta name="generator" content="Discourse 3.2"></head><body>${para(2)}</body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "thread", reason: "Discourse" });
  });

  test("repeated comment structure -> thread", () => {
    const post = (i: number) =>
      `<div class="post"><a class="username" href="/u/${i}">user${i}</a><time datetime="2024-01-0${i}">1d</time><div class="body">I think this is a reasonable point and here is why it matters to me today.</div></div>`;
    const d = doc(`<body><h1>Topic</h1><div class="posts">${[1, 2, 3, 4, 5, 6].map(post).join("")}</div></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "thread", reason: "repeated posts" });
  });

  test("QAPage JSON-LD -> thread", () => {
    const d = doc(`<head><script type="application/ld+json">{"@type":"QAPage","mainEntity":{"@type":"Question"}}</script></head><body>${para(2)}</body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("thread");
  });

  test("dominant player + VideoObject -> video", () => {
    const d = doc(`<head><script type="application/ld+json">{"@type":"VideoObject","name":"x"}</script></head>
      <body><video width="1200" height="675" src="v.mp4"><track kind="captions" src="c.vtt"></video><p>A short description of the video.</p></body>`);
    const v = fingerprintPage({ doc: d, url, viewport: VP });
    expect(v.type).toBe("video");
    expect(v.reason).toBe("VideoObject + large player");
  });

  test("embedded player iframe covering the page -> video", () => {
    const d = doc(`<body><iframe src="about:blank#player.vimeo.com/video/1" width="1100" height="620"></iframe></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("video");
  });

  test("an article with a small inline video stays an article", () => {
    const d = doc(`<head><meta property="og:type" content="article"></head><body><article>${para(10)}<video width="320" height="180"></video></article></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("article");
  });

  test("SRT text -> subtitles", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello there.\n\n2\n00:00:05,000 --> 00:00:07,500\nGeneral Kenobi.\n\n3\n00:00:08,000 --> 00:00:10,000\nYou are a bold one.\n";
    const d = doc(`<body><pre></pre></body>`);
    d.querySelector("pre")!.textContent = srt;
    expect(cueLineCount(srt).arrows).toBe(3);
    expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "subtitles", reason: "cue timestamps" });
  });

  test("WEBVTT text -> subtitles", () => {
    const d = doc(`<body><pre></pre></body>`);
    d.querySelector("pre")!.textContent = "WEBVTT\n\n00:01.000 --> 00:04.000\nHi.\n";
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("subtitles");
  });

  test("result list + filled search box -> search", () => {
    const item = (i: number) => `<li><h3><a href="https://site${i}.com">Result ${i}</a></h3><p>A snippet of text describing result number ${i} in a few words here.</p></li>`;
    const d = doc(`<body><form><input name="q" value="cats"></form><ol>${[1, 2, 3, 4, 5, 6].map(item).join("")}</ol></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "search", reason: "result list" });
  });

  test("editable app shell -> app", () => {
    const d = doc(`<body><div role="application"><div contenteditable="true" style="width:800px;height:600px"></div></div><button>Bold</button></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("app");
  });

  test("product page -> app", () => {
    const d = doc(`<head><meta property="og:type" content="product"><script type="application/ld+json">{"@type":"Product"}</script></head><body><h1>Shoe</h1><p>Buy now.</p></body>`);
    expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("app");
  });

  describe("ambiguous", () => {
    test("plain prose with no metadata -> article (fallback)", () => {
      const d = doc(`<body><div>${para(5)}</div></body>`);
      expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "article", via: "fallback" });
    });

    test("an empty-ish dashboard -> app (fallback)", () => {
      const d = doc(`<body><nav><a href="/a">A</a><a href="/b">B</a></nav><div>Welcome back</div></body>`);
      expect(fingerprintPage({ doc: d, url, viewport: VP })).toMatchObject({ type: "app", via: "fallback" });
    });

    test("blog post with a comment section stays an article", () => {
      const post = (i: number) =>
        `<div class="comment"><span class="author">u${i}</span><time>1d</time><p>Nice article, thanks for writing it up so clearly for all of us.</p></div>`;
      const d = doc(`<head><meta property="og:type" content="article"><meta name="generator" content="WordPress 6.5"></head>
        <body><article>${para(10)}</article><section>${[1, 2, 3, 4].map(post).join("")}</section></body>`);
      expect(fingerprintPage({ doc: d, url, viewport: VP }).type).toBe("article");
    });
  });
});

describe("combination and override", () => {
  test("URL rule wins over the fingerprint", () => {
    const d = doc(`<body>${para(10)}</body>`);
    expect(classifyPage({ doc: d, url: "https://www.youtube.com/watch?v=x", viewport: VP }).type).toBe("video");
  });

  test("override beats both; off is nothing", () => {
    const v = classifyPage({ doc: doc("<body></body>"), url: "https://www.reddit.com/", viewport: VP });
    expect(resolvePageType(v, "auto")).toBe(v);
    expect(resolvePageType(v, "article")).toMatchObject({ type: "article", via: "override" });
    expect(resolvePageType(v, "off")).toMatchObject({ off: true });
    expect(describeVerdict(v)).toBe("Page: thread (Reddit)");
  });
});
