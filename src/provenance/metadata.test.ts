import { describe, expect, it } from "vitest";
import { buildPng, iTXt, jpegWithXmp, tEXt, zTXt } from "./__fixtures__/build-png";
import { decodePng, readFixture } from "./__fixtures__/decode-png";
import expected from "./__fixtures__/expected.json";
import { digitalSourceTypeVerdict, extractMetadataSignals, matchGenerator, parseSdParameters } from "./metadata";
import { decodeStealthMetadata } from "./novelai";
import { parsePng } from "./png";
import { findXmpPackets, parseXmp } from "./xmp";

async function signalsFor(bytes: Uint8Array) {
  const png = await parsePng(bytes);
  return extractMetadataSignals(bytes, png);
}

const XMP_DST = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
 xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"
 photoshop:Credit="Made with Google AI"/>
</rdf:RDF></x:xmpmeta>`;

const XMP_MJ = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">
<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">a lighthouse at dusk --ar 3:2 Job ID: 0f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f</rdf:li></rdf:Alt></dc:description>
</rdf:Description></rdf:RDF></x:xmpmeta>`;

const XMP_AIGC = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:TC260="http://www.tc260.org.cn/ns/AIGC/1.0/"
 TC260:AIGC="{&quot;Label&quot;:&quot;1&quot;,&quot;ContentProducer&quot;:&quot;001191110108MA01KP2T5U00000&quot;,&quot;ProduceID&quot;:&quot;abc&quot;}"/>
</rdf:RDF></x:xmpmeta>`;

describe("PNG chunk walker", () => {
  it("reads tEXt, zTXt and iTXt (plain and compressed) and notes caBX", async () => {
    const bytes = buildPng([
      tEXt("parameters", "hello"),
      zTXt("prompt", '{"3":{"class_type":"KSampler"}}'),
      iTXt("Title", "héllo"),
      iTXt("Comment", "compressed ü", true),
      new Uint8Array([0, 0, 0, 0, 0x63, 0x61, 0x42, 0x58, 0, 0, 0, 0]), // empty caBX (bad CRC is fine)
    ]);
    const info = await parsePng(bytes);
    expect(info?.width).toBe(1);
    expect(info?.hasAlpha).toBe(true);
    expect(info?.hasC2pa).toBe(true);
    const t = Object.fromEntries(info!.texts.map((x) => [x.keyword, x.text]));
    expect(t).toMatchObject({
      parameters: "hello",
      prompt: '{"3":{"class_type":"KSampler"}}',
      Title: "héllo",
      Comment: "compressed ü",
    });
  });

  it("returns null for non-PNG input", async () => {
    expect(await parsePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("XMP scanner", () => {
  it("finds packets in JPEG bytes and extracts IPTC DigitalSourceType + Credit", () => {
    const packets = findXmpPackets(jpegWithXmp(XMP_DST));
    expect(packets).toHaveLength(1);
    const f = parseXmp(packets[0]!);
    expect(f.digitalSourceTypes).toEqual(["http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"]);
    expect(f.credit).toBe("Made with Google AI");
  });

  it("reads element-form values and rdf:Alt descriptions", () => {
    const f = parseXmp(XMP_MJ);
    expect(f.digitalSourceTypes).toHaveLength(1);
    expect(f.description).toContain("Job ID: 0f1c2d3e");
  });

  it("parses the GB 45438 AIGC JSON label", () => {
    const f = parseXmp(XMP_AIGC);
    expect(f.aigc).toMatchObject({ Label: "1", ProduceID: "abc" });
  });
});

describe("metadata signals (all unsigned claims)", () => {
  it("maps IPTC digital source types", () => {
    expect(digitalSourceTypeVerdict("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia")?.verdict).toBe("ai");
    expect(digitalSourceTypeVerdict("compositeWithTrainedAlgorithmicMedia")?.verdict).toBe("edited");
    expect(digitalSourceTypeVerdict("digitalCapture")?.verdict).toBe("camera");
    expect(digitalSourceTypeVerdict("minorHumanEdits")).toBeNull();
  });

  it("flags Google AI credit + DigitalSourceType in a JPEG", async () => {
    const s = await signalsFor(jpegWithXmp(XMP_DST));
    expect(s.length).toBeGreaterThanOrEqual(2);
    for (const sig of s) {
      expect(sig.kind).toBe("metadata");
      expect(sig.signed).toBe(false);
      expect(sig.trusted).toBe(false);
      expect(sig.detail).toMatch(/^Unsigned claim/);
    }
    expect(s.some((x) => x.provider === "Google")).toBe(true);
  });

  it("flags Midjourney XMP", async () => {
    const s = await signalsFor(jpegWithXmp(XMP_MJ));
    expect(s.some((x) => x.provider === "Midjourney")).toBe(true);
  });

  it("flags the China AIGC label (XMP and PNG tEXt)", async () => {
    expect((await signalsFor(jpegWithXmp(XMP_AIGC))).some((x) => x.provider === "GB 45438 AIGC label")).toBe(true);
    const png = buildPng([tEXt("AIGC", '{"Label":"1","ContentProducer":"x"}')]);
    const s = await signalsFor(png);
    expect(s[0]?.detail).toMatch(/declared AI-generated/);
  });

  it("recognises A1111, ComfyUI, InvokeAI and NovelAI PNG text chunks", async () => {
    const a1111 = await signalsFor(
      buildPng([tEXt("parameters", "cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Model: sdxl_base")]),
    );
    expect(a1111[0]?.provider).toMatch(/Stable Diffusion WebUI/);
    expect(a1111[0]?.detail).toMatch(/model sdxl_base/);
    const comfy = await signalsFor(buildPng([tEXt("prompt", '{"3":{"class_type":"KSampler","inputs":{}}}')]));
    expect(comfy[0]?.provider).toBe("ComfyUI");
    const invoke = await signalsFor(buildPng([tEXt("invokeai_metadata", "{}")]));
    expect(invoke[0]?.provider).toBe("InvokeAI");
    const nai = await signalsFor(buildPng([tEXt("Software", "NovelAI"), tEXt("Source", "NovelAI Diffusion V4.5")]));
    expect(nai[0]?.provider).toBe("NovelAI");
  });

  it("reads XMP stored in a compressed PNG iTXt chunk", async () => {
    const s = await signalsFor(buildPng([iTXt("XML:com.adobe.xmp", XMP_DST, true)]));
    expect(s.some((x) => x.verdict === "ai")).toBe(true);
  });

  it("finds nothing in an ordinary PNG", async () => {
    expect(await signalsFor(buildPng([tEXt("Title", "Holiday"), tEXt("Software", "GIMP 2.10")]))).toEqual([]);
  });

  it("reads the real fixture's A1111 parameters chunk", async () => {
    const s = await signalsFor(readFixture("sd1_bytes.png"));
    expect(s.map((x) => x.provider)).toContain("Stable Diffusion WebUI (A1111/Forge/SD.Next)");
  });

  it("parses SD parameters and matches generator names", () => {
    expect(parseSdParameters("x\nSteps: 30, Sampler: DPM++ 2M, Version: f2.0.1")?.version).toBe("f2.0.1");
    expect(parseSdParameters("Just a caption")).toBeNull();
    expect(matchGenerator("Adobe Firefly Image 3")).toBe("Adobe Firefly");
    expect(matchGenerator("Adobe Photoshop 25.0")).toBeUndefined();
  });
});

describe("NovelAI stealth metadata (alpha LSB)", () => {
  it("decodes the reference-format fixture", async () => {
    const img = decodePng(readFixture("novelai_stealth.png"));
    const r = await decodeStealthMetadata(img);
    expect(r?.mode).toBe("stealth_pngcomp");
    const exp = (expected as unknown as Record<string, { metadata: Record<string, string> }>)["novelai_stealth.png"]!.metadata;
    expect(r?.metadata?.Software).toBe(exp.Software);
    expect(r?.metadata?.Source).toBe(exp.Source);
    expect(r?.metadata?.Comment).toEqual(JSON.parse(exp.Comment!));
  });

  it("returns null for images without stealth data", async () => {
    expect(await decodeStealthMetadata(decodePng(readFixture("clean.png")))).toBeNull();
  });
});
