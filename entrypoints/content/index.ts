// Content script stub. TODO(T2): visible-text extraction, sentence
// segmentation, the 3 highlight styles, hidden-Unicode markers, the floating
// progress/score pill with ▲/▼ navigation and ✕ to clear, and Shadow-DOM
// tooltips (no page CSS leakage). See src/content/ for supporting modules.

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.log("[Local AI Detector] content script loaded (stub, see T2)");
  },
});
