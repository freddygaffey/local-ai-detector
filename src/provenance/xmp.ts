// Lightweight XMP scanner (our own code, MIT). Finds XMP packets anywhere in
// the file bytes (JPEG APP1, PNG iTXt passed in as text, WebP/AVIF/HEIC
// boxes) and pulls out the few AI-provenance fields we care about with
// regular expressions, so it works without a DOMParser (service workers,
// Web Workers, Node tests). It is deliberately forgiving: this is only an
// unsigned hint, never a verdict on its own.

export interface XmpFields {
  /** Iptc4xmpExt:DigitalSourceType URI(s). */
  digitalSourceTypes: string[];
  creatorTool?: string;
  credit?: string;
  description?: string;
  /** China GB 45438-2025 implicit label (TC260 AIGC namespace), parsed. */
  aigc?: Record<string, unknown>;
  /** Raw AIGC value if it was not JSON. */
  aigcRaw?: string;
  /** Any other field that names a known generator (e.g. softwareAgent). */
  softwareAgents: string[];
}

const START = "<x:xmpmeta";
const END = "</x:xmpmeta>";

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const max = hay.length - needle.length;
  for (let i = hay.indexOf(first!, from); i !== -1 && i <= max; i = hay.indexOf(first!, i + 1)) {
    let ok = true;
    for (let j = 1; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

const enc = new TextEncoder();
const START_B = enc.encode(START);
const END_B = enc.encode(END);
const MAX_PACKET = 4 * 1024 * 1024;
const MAX_PACKETS = 8;

/** Extracts every XMP packet (as text) found in raw file bytes. */
export function findXmpPackets(bytes: Uint8Array): string[] {
  const out: string[] = [];
  const dec = new TextDecoder("utf-8");
  let from = 0;
  while (out.length < MAX_PACKETS) {
    const s = indexOfBytes(bytes, START_B, from);
    if (s < 0) break;
    const e = indexOfBytes(bytes, END_B, s);
    if (e < 0 || e - s > MAX_PACKET) break;
    out.push(dec.decode(bytes.subarray(s, e + END_B.length)));
    from = e + END_B.length;
  }
  return out;
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/**
 * Values of a (namespace-prefixed) property, whether written as an
 * attribute (`prefix:Name="v"`) or an element (`<prefix:Name>v</...>`,
 * including rdf:Alt/rdf:Seq/rdf:Bag `<rdf:li>` children). The prefix is
 * matched loosely (`[\w-]*:`) because generators use different prefixes.
 */
export function xmpValues(xmp: string, localName: string): string[] {
  const out: string[] = [];
  const name = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attr = new RegExp(`[\\s<][\\w-]*:${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g");
  for (const m of xmp.matchAll(attr)) out.push(unescapeXml(m[1] ?? m[2] ?? ""));
  const elem = new RegExp(`<([\\w-]*:${name})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, "g");
  for (const m of xmp.matchAll(elem)) {
    const inner = m[2] ?? "";
    const lis = [...inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((x) => x[1] ?? "");
    const resource = /rdf:resource\s*=\s*"([^"]*)"/.exec(m[0]);
    if (lis.length) out.push(...lis.map((v) => unescapeXml(v.trim())));
    else if (inner.trim() && !inner.includes("<")) out.push(unescapeXml(inner.trim()));
    else if (resource) out.push(unescapeXml(resource[1]!));
  }
  // Self-closing element with rdf:resource, e.g. <Iptc4xmpExt:DigitalSourceType rdf:resource="..."/>
  const selfClosing = new RegExp(`<[\\w-]*:${name}\\s[^>]*rdf:resource\\s*=\\s*"([^"]*)"[^>]*/>`, "g");
  for (const m of xmp.matchAll(selfClosing)) out.push(unescapeXml(m[1]!));
  return out.filter((v) => v.length > 0);
}

export function parseAigc(value: string): { parsed?: Record<string, unknown>; raw: string } {
  const raw = unescapeXml(value).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { parsed: parsed as Record<string, unknown>, raw };
    }
  } catch {
    // not JSON
  }
  return { raw };
}

export function parseXmp(xmp: string): XmpFields {
  const fields: XmpFields = {
    digitalSourceTypes: [...new Set(xmpValues(xmp, "DigitalSourceType"))],
    softwareAgents: [...new Set(xmpValues(xmp, "softwareAgent"))],
  };
  fields.creatorTool = xmpValues(xmp, "CreatorTool")[0];
  fields.credit = xmpValues(xmp, "Credit")[0];
  // dc:description (lower-case local name; `rdf:Description` is a wrapper, not a field).
  fields.description = xmpValues(xmp, "description")[0];
  if (/tc260\.org\.cn\/ns\/AIGC/i.test(xmp) || /[\s<][\w-]*:AIGC\s*=/.test(xmp)) {
    const v = xmpValues(xmp, "AIGC")[0];
    if (v) {
      const { parsed, raw } = parseAigc(v);
      if (parsed) fields.aigc = parsed;
      else fields.aigcRaw = raw;
    } else {
      // Individual properties in the AIGC namespace.
      const obj: Record<string, unknown> = {};
      for (const k of ["Label", "ContentProducer", "ProduceID", "ContentPropagator", "PropagateID"]) {
        const val = xmpValues(xmp, k)[0];
        if (val) obj[k] = val;
      }
      if (Object.keys(obj).length) fields.aigc = obj;
    }
  }
  return fields;
}
