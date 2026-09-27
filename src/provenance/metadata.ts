// Unsigned AI-provenance metadata: IPTC DigitalSourceType (XMP), Google's
// "Made with Google AI" credit, generator text chunks (A1111/Forge/SD.Next
// `parameters`, ComfyUI `prompt`/`workflow`, InvokeAI, NovelAI, Fooocus),
// Midjourney XMP description + Job ID, China GB 45438-2025 `AIGC` labels,
// and EXIF Software / UserComment. Everything here is an *unsigned claim*:
// trivially forged or stripped, so it is a positive hint only.
//
// ExifReader (MPL-2.0, unmodified) parses EXIF/IPTC; XMP and PNG text chunks
// use our own parsers (./xmp.ts, ./png.ts) so no DOMParser is needed.

import ExifReader from "exifreader";
import type { ImageSignal, Verdict } from "./types";
import type { PngInfo } from "./png";
import { findXmpPackets, parseAigc, parseXmp } from "./xmp";

// ---- IPTC Digital Source Type ----

export function shortDigitalSourceType(uri: string): string {
  const s = uri.trim();
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("#"), s.lastIndexOf(":"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Maps an IPTC digital source type (short or full URI) to our verdict. */
export function digitalSourceTypeVerdict(uri: string): { verdict: Verdict; text: string } | null {
  switch (shortDigitalSourceType(uri)) {
    case "trainedAlgorithmicMedia":
      return { verdict: "ai", text: "AI-generated (trained algorithmic media)" };
    case "compositeWithTrainedAlgorithmicMedia":
      return { verdict: "edited", text: "edited or composited with AI" };
    case "algorithmicMedia":
      return { verdict: "ai", text: "created by an algorithm (algorithmic media)" };
    case "compositeSynthetic":
      return { verdict: "edited", text: "composite including synthetic elements" };
    case "digitalCapture":
    case "computationalCapture":
    case "negativeFilm":
    case "positiveFilm":
    case "print":
      return { verdict: "camera", text: "captured with a camera or scanner" };
    default:
      return null;
  }
}

// ---- Known generator names (EXIF Software, XMP CreatorTool, softwareAgent) ----

const GENERATORS: Array<[RegExp, string]> = [
  [/novel\s*ai/i, "NovelAI"],
  [/midjourney/i, "Midjourney"],
  [/dall[·\-\s]?e/i, "OpenAI DALL·E"],
  [/gpt[-\s]?image|chatgpt|openai/i, "OpenAI"],
  [/firefly/i, "Adobe Firefly"],
  [/imagen|gemini|nano[\s-]?banana|made with google ai/i, "Google"],
  [/stable\s*diffusion|sdxl|automatic1111|a1111|sd\.next|forge/i, "Stable Diffusion"],
  [/comfy\s*ui/i, "ComfyUI"],
  [/invoke\s*ai/i, "InvokeAI"],
  [/fooocus/i, "Fooocus"],
  [/\bflux(\.\d)?\b|black\s*forest\s*labs/i, "FLUX"],
  [/draw\s*things/i, "Draw Things"],
  [/diffusionbee/i, "DiffusionBee"],
  [/leonardo(\.ai)?/i, "Leonardo.Ai"],
  [/ideogram/i, "Ideogram"],
  [/playground\s*(ai|v\d)/i, "Playground"],
  [/bing image creator|microsoft designer|copilot designer/i, "Microsoft Designer"],
  [/runway/i, "Runway"],
  [/recraft/i, "Recraft"],
  [/krea/i, "Krea"],
  [/grok|aurora \(xai\)|\bxai\b/i, "xAI Grok"],
  [/kling|hailuo|minimax|doubao|jimeng|dreamina|tongyi|wanxiang|qwen|ernie|hunyuan|seedream/i, "Chinese AI provider"],
];

export function matchGenerator(text: string | undefined): string | undefined {
  if (!text) return undefined;
  for (const [re, name] of GENERATORS) if (re.test(text)) return name;
  return undefined;
}

// ---- Signal builders ----

function claim(verdict: Verdict, detail: string, provider?: string): ImageSignal {
  return {
    kind: "metadata",
    verdict,
    trusted: false,
    signed: false,
    label: verdict === "edited" ? "AI edit claim" : verdict === "camera" ? "Capture claim" : "AI claim",
    detail: `Unsigned claim: ${detail}`,
    provider,
  };
}

function truncate(s: string, n = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A1111/Forge/SD.Next "parameters" text: "<prompt>\nSteps: 20, Sampler: ..., Model: x". */
export function parseSdParameters(text: string): { model?: string; version?: string } | null {
  if (!/(^|\n|,\s*)Steps:\s*\d+/.test(text) || !/Sampler:|CFG scale:|Seed:/.test(text)) return null;
  const model = /(?:^|,\s*)Model:\s*([^,\n]+)/m.exec(text)?.[1]?.trim();
  const version = /(?:^|,\s*)Version:\s*([^,\n]+)/m.exec(text)?.[1]?.trim();
  return { model, version };
}

function aigcSignal(aigc: Record<string, unknown> | undefined, raw?: string): ImageSignal {
  const label = aigc?.Label ?? aigc?.label;
  const producer = aigc?.ContentProducer ?? aigc?.contentProducer;
  const labelText =
    String(label) === "1"
      ? "declared AI-generated"
      : String(label) === "2"
        ? "declared possibly AI-generated"
        : String(label) === "3"
          ? "suspected AI-generated"
          : "AI-generated content label";
  const detail =
    `China GB 45438-2025 AIGC implicit label: ${labelText}` +
    (producer ? ` (producer ${truncate(String(producer), 60)})` : "") +
    (!aigc && raw ? ` (${truncate(raw, 80)})` : "");
  return claim("ai", detail, "GB 45438 AIGC label");
}

function signalsFromPngText(texts: PngInfo["texts"]): { signals: ImageSignal[]; xmpTexts: string[] } {
  const signals: ImageSignal[] = [];
  const xmpTexts: string[] = [];
  const byKey = new Map<string, string>();
  for (const t of texts) {
    if (!byKey.has(t.keyword)) byKey.set(t.keyword, t.text);
    if (t.keyword === "XML:com.adobe.xmp") xmpTexts.push(t.text);
  }
  const params = byKey.get("parameters");
  if (params !== undefined) {
    const sd = parseSdParameters(params);
    const fooocus = /fooocus/i.test(params);
    const provider = fooocus ? "Fooocus" : "Stable Diffusion WebUI (A1111/Forge/SD.Next)";
    signals.push(
      claim(
        "ai",
        `PNG "parameters" generation settings from ${provider}` +
          (sd?.model ? `, model ${truncate(sd.model, 60)}` : "") +
          (sd?.version ? `, version ${truncate(sd.version, 30)}` : ""),
        provider,
      ),
    );
  }
  const comfyPrompt = byKey.get("prompt");
  const comfyWorkflow = byKey.get("workflow");
  if ((comfyPrompt && /class_type|"inputs"/.test(comfyPrompt)) || (comfyWorkflow && /"nodes"/.test(comfyWorkflow))) {
    signals.push(claim("ai", "ComfyUI workflow/prompt graph embedded in PNG text chunks", "ComfyUI"));
  }
  for (const key of ["invokeai_metadata", "invokeai_graph", "sd-metadata", "Dream"]) {
    if (byKey.has(key)) {
      signals.push(claim("ai", `InvokeAI generation metadata ("${key}")`, "InvokeAI"));
      break;
    }
  }
  if (byKey.has("fooocus_scheme") && !params) {
    signals.push(claim("ai", "Fooocus generation metadata", "Fooocus"));
  }
  const software = byKey.get("Software");
  const source = byKey.get("Source");
  if ((software && /novel\s*ai/i.test(software)) || (source && /novel\s*ai/i.test(source))) {
    signals.push(
      claim("ai", `NovelAI generation metadata${source ? ` (${truncate(source, 60)})` : ""}`, "NovelAI"),
    );
  } else if (software) {
    const gen = matchGenerator(software);
    if (gen) signals.push(claim("ai", `PNG Software field names an AI generator: "${truncate(software, 60)}"`, gen));
  }
  const aigc = byKey.get("AIGC");
  if (aigc !== undefined) {
    const { parsed, raw } = parseAigc(aigc);
    signals.push(aigcSignal(parsed, raw));
  }
  return { signals, xmpTexts };
}

function signalsFromXmp(xmpText: string): ImageSignal[] {
  const f = parseXmp(xmpText);
  const out: ImageSignal[] = [];
  for (const dst of f.digitalSourceTypes) {
    const v = digitalSourceTypeVerdict(dst);
    // An unsigned "camera" claim is not worth a badge; only surface AI-related types.
    if (v && v.verdict !== "camera") {
      out.push(claim(v.verdict, `IPTC DigitalSourceType says ${v.text} (${shortDigitalSourceType(dst)})`, matchGenerator(f.creatorTool) ?? matchGenerator(f.credit)));
    }
  }
  if (f.credit && /made with google ai/i.test(f.credit)) {
    out.push(claim("ai", `IPTC Credit: "${truncate(f.credit, 60)}"`, "Google"));
  }
  if (f.description && /job\s*id:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i.test(f.description)) {
    out.push(claim("ai", "Midjourney prompt and Job ID in XMP description", "Midjourney"));
  }
  const tool = matchGenerator(f.creatorTool);
  if (tool) out.push(claim("ai", `XMP CreatorTool names an AI generator: "${truncate(f.creatorTool!, 60)}"`, tool));
  for (const agent of f.softwareAgents) {
    const gen = matchGenerator(agent);
    if (gen) out.push(claim("ai", `XMP softwareAgent names an AI generator: "${truncate(agent, 60)}"`, gen));
  }
  if (f.aigc || f.aigcRaw) out.push(aigcSignal(f.aigc, f.aigcRaw));
  return out;
}

interface ExifLike {
  exif?: Record<string, { description?: string; value?: unknown } | undefined>;
  iptc?: Record<string, { description?: string; value?: unknown } | undefined>;
}

function readExif(bytes: Uint8Array): ExifLike | null {
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return ExifReader.load(buf, {
      expanded: true,
      includeTags: { exif: true, iptc: true },
    }) as unknown as ExifLike;
  } catch {
    return null;
  }
}

function signalsFromExif(tags: ExifLike): ImageSignal[] {
  const out: ImageSignal[] = [];
  const desc = (group: ExifLike["exif"], key: string): string | undefined => {
    const t = group?.[key];
    if (!t) return undefined;
    const d = t.description ?? (typeof t.value === "string" ? t.value : undefined);
    return typeof d === "string" && d.trim() ? d : undefined;
  };
  const software = desc(tags.exif, "Software");
  const gen = matchGenerator(software);
  if (gen) out.push(claim("ai", `EXIF Software names an AI generator: "${truncate(software!, 60)}"`, gen));
  const userComment = desc(tags.exif, "UserComment");
  if (userComment && parseSdParameters(userComment)) {
    out.push(claim("ai", "Stable Diffusion WebUI generation settings in EXIF UserComment", "Stable Diffusion WebUI (A1111/Forge/SD.Next)"));
  }
  const imageDescription = desc(tags.exif, "ImageDescription");
  if (imageDescription && parseSdParameters(imageDescription)) {
    out.push(claim("ai", "Stable Diffusion generation settings in EXIF ImageDescription", "Stable Diffusion"));
  }
  const credit = desc(tags.iptc, "Credit");
  if (credit && /made with google ai/i.test(credit)) {
    out.push(claim("ai", `IPTC Credit: "${truncate(credit, 60)}"`, "Google"));
  }
  return out;
}

function dedupe(signals: ImageSignal[]): ImageSignal[] {
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = `${s.kind}|${s.verdict}|${s.provider ?? ""}|${s.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extracts every unsigned AI-provenance claim from the file's metadata. */
export function extractMetadataSignals(bytes: Uint8Array, png: PngInfo | null): ImageSignal[] {
  const signals: ImageSignal[] = [];
  const xmpTexts: string[] = [];
  if (png) {
    const fromPng = signalsFromPngText(png.texts);
    signals.push(...fromPng.signals);
    xmpTexts.push(...fromPng.xmpTexts);
  }
  // Uncompressed XMP anywhere in the file (JPEG APP1, WebP/AVIF/HEIC, PNG iTXt).
  for (const packet of findXmpPackets(bytes)) if (!xmpTexts.includes(packet)) xmpTexts.push(packet);
  for (const x of xmpTexts) signals.push(...signalsFromXmp(x));
  if (!png || png.hasExif) {
    const tags = readExif(bytes);
    if (tags) signals.push(...signalsFromExif(tags));
  }
  return dedupe(signals);
}
