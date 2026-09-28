// Chrome's PDF viewer: the content script runs in the wrapper document, but
// the text lives inside the viewer plugin, out of reach. Answer the popup and
// background with "this is a PDF" and render nothing on the page.

import { registerHandlers } from "../shared/messages";
import { unreadableError } from "../shared/unreadable";

export function isPdfDocument(doc: Document = document): boolean {
  return doc.contentType === "application/pdf";
}

export function bootPdfStub(): void {
  const host = location.hostname;
  registerHandlers({
    getPageType: () => ({ type: "app", reason: "PDF", via: "fallback", off: true, host, pdf: true }),
    getSelectionInfo: () => ({ hasSelection: false }),
    extractText: () => {
      throw unreadableError("pdf");
    },
    renderHighlights: () => ({ ok: true }),
    clearHighlights: () => ({ ok: true }),
    toggleVisibility: () => ({ ok: true }),
  });
}
