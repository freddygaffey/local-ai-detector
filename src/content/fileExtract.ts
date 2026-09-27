// Local file/paste text extraction for the popup's "Paste text" box and file
// drop (docs/plan.md "More entry points": .txt, .md, .html, .docx; PDF is
// out of scope for v1). Extraction is local and dependency-free -- .docx is
// read as a zip (Word doesn't use zip64 or streamed/data-descriptor entries
// for a plain .docx, so a straightforward sequential local-file-header scan
// is enough) and decompressed with the browser's native `DecompressionStream`
// ("deflate-raw"), so no third-party zip/inflate library is needed (see
// THIRD_PARTY.md -- nothing was added for this).

export type SupportedFileExt = "txt" | "md" | "html" | "htm" | "docx";

const EXT_RE = /\.([a-z0-9]+)$/i;

export function extFromFilename(name: string): SupportedFileExt | null {
  const m = EXT_RE.exec(name.toLowerCase());
  const ext = m?.[1];
  if (ext === "txt" || ext === "md" || ext === "html" || ext === "htm" || ext === "docx") return ext;
  return null;
}

export const ACCEPTED_FILE_EXTENSIONS = ".txt,.md,.html,.htm,.docx";

/** Light markdown-syntax stripping (headings/emphasis/links/code/images) -- not a full parser, just enough to keep prose clean for scoring. */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, "$1")
    .trim();
}

/** Uses the DOM extractor over a parsed (detached) document -- the same visible-text logic as the live page. */
export async function htmlToText(html: string): Promise<string> {
  const { extractVisibleBlocks } = await import("./extract");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks = extractVisibleBlocks(doc);
  return blocks.map((b) => b.text).join("\n\n");
}

// ---- .docx: minimal zip reader + WordprocessingML text extraction ----

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  data: Uint8Array;
}

/** Sequentially scans local file headers (stops at the first non-matching signature, i.e. the central directory). */
function readZipEntries(buf: ArrayBufferLike): ZipEntry[] {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === LOCAL_FILE_HEADER_SIGNATURE) {
    // Standard ZIP local file header layout: sig(4) version(2) flags(2)
    // method(2) time(2) date(2) crc32(4) compSize(4) uncompSize(4) nameLen(2)
    // extraLen(2) = 30 bytes, then the filename, then the extra field.
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    if (flags & 0x08 && compSize === 0) {
      throw new Error("This .docx file uses a zip layout that can't be read locally.");
    }
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    entries.push({ name, method, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return entries;
}

async function inflateRawRuntime(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't decompress .docx files (no DecompressionStream).");
  }
  // Re-copy into a plain (non-shared, non-offset) buffer: `data` is a
  // subarray view and newer TS lib types don't let a Uint8Array<ArrayBufferLike>
  // straight into BlobPart.
  const copy = new Uint8Array(data);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extracts paragraph text from a WordprocessingML `word/document.xml` body (regex-based; no XML parser needed). */
export function wordXmlToText(xml: string): string {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const chunk of paragraphs) {
    const runs = Array.from(chunk.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)).map((m) => decodeXmlEntities(m[1] ?? ""));
    const line = runs.join("");
    if (line.trim().length > 0) lines.push(line);
  }
  return lines.join("\n\n");
}

/** Reads a .docx (ArrayBuffer) and returns its plain text. */
export async function docxToText(buf: ArrayBufferLike): Promise<string> {
  const entries = readZipEntries(buf);
  const doc = entries.find((e) => e.name === "word/document.xml");
  if (!doc) throw new Error("Couldn't find document content in this .docx file.");
  const xmlBytes = doc.method === 0 ? doc.data : await inflateRawRuntime(doc.data);
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  return wordXmlToText(xml);
}

/** Extracts plain text from a dropped/selected file. Throws a user-facing message on any failure. */
export async function extractTextFromFile(file: File): Promise<string> {
  const ext = extFromFilename(file.name);
  if (!ext) throw new Error("Unsupported file type. Use .txt, .md, .html or .docx.");
  if (ext === "docx") return docxToText(await file.arrayBuffer());
  const raw = await file.text();
  if (ext === "md") return markdownToText(raw);
  if (ext === "html" || ext === "htm") return htmlToText(raw);
  return raw;
}
