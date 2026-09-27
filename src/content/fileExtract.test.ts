// @vitest-environment happy-dom
//
// Builds minimal real .docx-shaped zip buffers with Node's zlib (test-only;
// the extractor itself never uses zlib -- it uses the runtime's
// DecompressionStream, exercised here too) to verify docxToText end to end.

import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { docxToText, extFromFilename, extractTextFromFile, htmlToText, markdownToText, wordXmlToText } from "./fileExtract";

function localFileHeader(name: string, data: Uint8Array, method: 0 | 8): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, 0, true); // flags (no data descriptor)
  view.setUint16(8, method, true);
  view.setUint16(10, 0, true); // mod time
  view.setUint16(12, 0, true); // mod date
  view.setUint32(14, 0, true); // crc32 (unused by our reader)
  view.setUint32(18, data.length, true); // compressed size
  view.setUint32(22, data.length, true); // "uncompressed size" (unused by our reader)
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true); // extra length
  header.set(nameBytes, 30);
  header.set(data, 30 + nameBytes.length);
  return header;
}

function buildDocx(documentXml: string): ArrayBuffer {
  const raw = new TextEncoder().encode(documentXml);
  const compressed = new Uint8Array(deflateRawSync(Buffer.from(raw)));
  const entry = localFileHeader("word/document.xml", compressed, 8);
  // A second, unrelated stored entry, to check the scanner keeps going past non-matching names.
  const rels = localFileHeader("[Content_Types].xml", new TextEncoder().encode("<Types/>"), 0);
  const combined = new Uint8Array(rels.length + entry.length);
  combined.set(rels, 0);
  combined.set(entry, rels.length);
  return combined.buffer;
}

const SIMPLE_DOCUMENT_XML =
  '<?xml version="1.0"?><w:document><w:body>' +
  "<w:p><w:r><w:t>First paragraph, plenty of words to score.</w:t></w:r></w:p>" +
  '<w:p><w:r><w:t>Second paragraph &amp; an ampersand.</w:t></w:r></w:p>' +
  "</w:body></w:document>";

describe("wordXmlToText", () => {
  test("joins run text per paragraph and decodes entities", () => {
    const text = wordXmlToText(SIMPLE_DOCUMENT_XML);
    expect(text).toContain("First paragraph, plenty of words to score.");
    expect(text).toContain("Second paragraph & an ampersand.");
  });
});

describe("docxToText", () => {
  test("reads a deflate-compressed word/document.xml entry", async () => {
    const buf = buildDocx(SIMPLE_DOCUMENT_XML);
    const text = await docxToText(buf);
    expect(text).toContain("First paragraph");
    expect(text).toContain("Second paragraph & an ampersand.");
  });

  test("throws a clear error when word/document.xml is missing", async () => {
    const entry = localFileHeader("[Content_Types].xml", new TextEncoder().encode("<Types/>"), 0);
    await expect(docxToText(entry.buffer)).rejects.toThrow(/document content/i);
  });
});

describe("markdownToText", () => {
  test("strips headings, emphasis, links and code fences", () => {
    const md = "# Title\n\nSome **bold** and _italic_ text with a [link](https://example.com).\n\n```js\ncode();\n```\n";
    const text = markdownToText(md);
    expect(text).not.toContain("#");
    expect(text).not.toContain("**");
    expect(text).toContain("bold");
    expect(text).toContain("link");
    expect(text).not.toContain("code();");
  });
});

describe("htmlToText", () => {
  test("extracts visible prose the same way the page extractor does", async () => {
    const html = "<html><body><nav>Skip</nav><article><p>" + "Hello world, this is a reasonably long paragraph of prose. ".repeat(3) + "</p></article></body></html>";
    const text = await htmlToText(html);
    expect(text).toContain("Hello world");
    expect(text).not.toContain("Skip");
  });
});

describe("extFromFilename / extractTextFromFile", () => {
  test("extFromFilename recognizes supported extensions only", () => {
    expect(extFromFilename("a.TXT")).toBe("txt");
    expect(extFromFilename("a.docx")).toBe("docx");
    expect(extFromFilename("a.pdf")).toBeNull();
  });

  test("extractTextFromFile dispatches a .txt file straight through", async () => {
    const file = new File(["plain text content"], "note.txt", { type: "text/plain" });
    expect(await extractTextFromFile(file)).toBe("plain text content");
  });

  test("extractTextFromFile rejects an unsupported extension", async () => {
    const file = new File(["%PDF-1.4"], "doc.pdf", { type: "application/pdf" });
    await expect(extractTextFromFile(file)).rejects.toThrow(/unsupported/i);
  });
});
