// Tiny static server for the E2E fixture pages (scripts/e2e/fixtures/),
// dev/demo.html, and the provenance test images from
// src/provenance/__fixtures__ (served under /img/). Listens on 127.0.0.1;
// pages are opened as localhost and reference "cross-origin" images via
// 127.0.0.1.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

/** clean.png with an unsigned IPTC "trainedAlgorithmicMedia" claim in an XMP iTXt chunk. */
function aiClaimPng() {
  const png = readFileSync(root("src/provenance/__fixtures__/clean.png"));
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
    'Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>' +
    "</rdf:RDF></x:xmpmeta>";
  const data = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")]);
  const type = Buffer.from("iTXt", "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0);
  const ihdrEnd = 8 + 8 + 13 + 4; // signature + IHDR (len, type, data, crc)
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

const IMAGES = {
  "/img/sd1.png": () => readFileSync(root("src/provenance/__fixtures__/sd1_bytes.png")),
  "/img/clean.png": () => readFileSync(root("src/provenance/__fixtures__/clean.png")),
  "/img/c2pa.jpg": () => readFileSync(root("src/provenance/__fixtures__/c2pa/CA.jpg")),
  "/img/ai-claim.png": aiClaimPng,
};

export function startServer(port = 0) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    log.push(`${req.headers.host} ${url.pathname}`);
    try {
      if (IMAGES[url.pathname]) {
        const body = IMAGES[url.pathname]();
        res.writeHead(200, {
          "content-type": url.pathname.endsWith(".jpg") ? "image/jpeg" : "image/png",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end(body);
      }
      let file;
      if (url.pathname === "/demo.html") file = root("dev/demo.html");
      else if (/^\/[a-z-]+\.html$/.test(url.pathname)) file = root(`scripts/e2e/fixtures${url.pathname}`);
      if (!file) {
        res.writeHead(404);
        return res.end("not found");
      }
      const html = readFileSync(file, "utf8").replaceAll("{PORT}", String(server.address().port));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, log, close: () => server.close() })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.argv[2] ?? 8765));
  console.log(`fixtures on http://localhost:${port}/ (blog.html, news.html, spa.html, demo.html)`);
}
