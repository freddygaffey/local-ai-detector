// Side panel "Transcript" section on YouTube video pages (docs/plan.md
// "Phase 2: T10"): the transcript score, YouTube's own disclosure label as a
// separate line, and the flagged segments with timestamps; clicking one
// seeks the video. Asks the tab's content script (`getTranscriptReport`);
// renders nothing off YouTube.

import { sendTabMessage } from "../shared/messages";
import { FLAGGED_THRESHOLD } from "../shared/thresholds";
import type { TranscriptReport } from "../shared/transcript";
import { formatTimestamp } from "../content/youtube/transcript";
import { chipLabel, detailsMeta } from "../content/youtube/ui";
import { h } from "./dom";

export function transcriptSection(tabId: number): HTMLElement {
  const root = h("section", { class: "sp-transcript", hidden: true });
  const load = (run: boolean) => {
    sendTabMessage(tabId, "getTranscriptReport", run ? { run: true } : undefined)
      .then((r) => render(r))
      .catch(() => render(null));
  };
  const render = (r: TranscriptReport | null) => {
    root.replaceChildren();
    root.hidden = !r;
    if (!r) return;
    const label = chipLabel(r);
    root.append(h("div", { class: "sp-summary" }, h("span", { class: "sp-score" }, label.text)));
    if (r.disclosure) root.append(h("p", { class: "sp-word" }, `YouTube label: ${r.disclosure}`));
    if (r.state === "idle" || r.state === "error") {
      root.append(h("button", { class: "btn btn-block", type: "button", onclick: () => (render({ ...r, state: "running" }), load(true)) }, "Check transcript"));
      return;
    }
    if (r.state === "running") {
      setTimeout(() => load(false), 1500);
      return;
    }
    if (r.state !== "done") return;
    const flagged = r.segments.filter((s) => s.score >= FLAGGED_THRESHOLD);
    if (flagged.length > 0) {
      const list = h("ul", { class: "sp-list" });
      for (const s of flagged) {
        list.append(
          h(
            "li",
            null,
            h(
              "button",
              { class: "sp-item", type: "button", onclick: () => void sendTabMessage(tabId, "seekVideo", { seconds: s.start }).catch(() => {}) },
              h("span", { class: "sp-item-score" }, s.probability !== undefined ? `${Math.round(s.probability * 100)}%` : "—"),
              h("span", { class: "sp-item-label" }, `${formatTimestamp(s.start)} · ${s.snippet}`),
            ),
          ),
        );
      }
      root.append(list);
    }
    root.append(h("p", { class: "sp-word" }, detailsMeta(r)));
  };
  load(false);
  return root;
}
