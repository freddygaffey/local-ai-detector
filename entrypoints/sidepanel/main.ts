// Side panel (docs/plan.md "T9: Presence modes" -- Side panel): a full
// report of flagged sentences (or, on a chat/comment/thread page, flagged
// items) that follows the active tab; clicking one scrolls to it on the
// page. Never marks the page itself.

import "../../src/ui/styles.css";
import "./sidepanel.css";

import { browser } from "wxt/browser";
import { getSettings, watchSettings } from "@/src/shared/settings";
import type { Settings } from "@/src/shared/settings";
import { onAnalysisStatus, sendMessage, sendTabMessage } from "@/src/shared/messages";
import type { AnalyzeResult, TabAnalysisStatus } from "@/src/shared/messages";
import { clearChildren, h } from "@/src/ui/dom";
import { BAND_LABEL, bandClassName, bandFromResult } from "@/src/ui/verdict";
import { displayScore } from "@/src/ui/probability";
import { formatPercent } from "@/src/ui/format";
import { FLAGGED_THRESHOLD } from "@/src/shared/thresholds";
import { brandMark } from "@/src/ui/icons";
import { mountToastHost, showToast } from "@/src/ui/toast";
import { CONSENT_REQUIRED_ERROR } from "@/src/shared/messages";

interface Ctx {
  settings: Settings;
  tabId: number | null;
  result: AnalyzeResult | null;
  status: TabAnalysisStatus["state"];
}

const ctx: Ctx = { settings: await getSettings(), tabId: null, result: null, status: "idle" };
const root = document.getElementById("app") as HTMLDivElement;
let unsubscribeStatus: (() => void) | null = null;

async function main() {
  mountToastHost();
  await followActiveTab();
  browser.tabs.onActivated.addListener(() => void followActiveTab());
  browser.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "loading" && tab.active) void followActiveTab();
  });
  watchSettings((s) => {
    ctx.settings = s;
    render();
  });
  render();
}

async function followActiveTab(): Promise<void> {
  unsubscribeStatus?.();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  ctx.tabId = tab?.id ?? null;
  ctx.result = null;
  ctx.status = "idle";
  if (ctx.tabId !== null) {
    const tabId = ctx.tabId;
    sendMessage("getTabStatus", { tabId })
      .then(applyStatus)
      .catch(() => {})
      .finally(render);
    unsubscribeStatus = onAnalysisStatus((eventTabId, status) => {
      if (eventTabId !== tabId) return;
      applyStatus(status);
      render();
    });
  } else {
    render();
  }
}

function applyStatus(status: TabAnalysisStatus): void {
  ctx.status = status.state;
  if (status.state === "done") ctx.result = status.result;
}

function render(): void {
  clearChildren(root);
  root.append(
    h("header", { class: "sp-header" }, brandMark(), h("h1", null, "Local AI Detector")),
    ctx.tabId === null ? renderEmpty("No page to report on.") : renderBody(),
  );
}

function renderEmpty(text: string): HTMLElement {
  return h("div", { class: "sp-empty" }, h("p", null, text));
}

function renderBody(): HTMLElement {
  const body = h("div", { class: "sp-body" });
  if (ctx.status === "running") {
    body.append(renderEmpty("Analyzing…"));
    return body;
  }
  if (!ctx.result) {
    body.append(
      renderEmpty("No result yet."),
      h("button", { class: "btn btn-primary btn-block", type: "button", onclick: () => void runAnalyze() }, "Analyze page"),
    );
    return body;
  }
  const result = ctx.result;
  const band = bandFromResult(result, ctx.settings);
  const score = displayScore(result);
  body.append(
    h(
      "div",
      { class: "sp-summary" },
      h("span", { class: `sp-score ${bandClassName(band)}` }, score !== null ? `AI ${Math.round(score * 100)}%` : "—"),
      h("span", { class: "sp-word" }, BAND_LABEL[band]),
    ),
  );
  const flagged = result.sentences.filter((s) => s.score >= FLAGGED_THRESHOLD);
  if (flagged.length === 0) {
    body.append(renderEmpty("Nothing flagged."));
  } else {
    const list = h("ul", { class: "sp-list" });
    for (const s of flagged) {
      const item = h(
        "li",
        null,
        h(
          "button",
          {
            class: "sp-item",
            type: "button",
            onclick: () => void scrollTo(s.blockId, s.index),
          },
          h("span", { class: "sp-item-score" }, formatPercent(s.score)),
          h("span", { class: "sp-item-label" }, `Block ${s.blockId.slice(-6)} · sentence ${s.index + 1}`),
        ),
      );
      list.append(item);
    }
    body.append(list);
  }
  return body;
}

async function scrollTo(blockId: string, index: number): Promise<void> {
  if (ctx.tabId === null) return;
  await sendTabMessage(ctx.tabId, "scrollToSentence", { blockId, index }).catch(() => {});
}

async function runAnalyze(): Promise<void> {
  if (ctx.tabId === null) return;
  ctx.status = "running";
  render();
  try {
    const result = await sendMessage("analyzeTab", { tabId: ctx.tabId, target: "page" });
    ctx.result = result;
    ctx.status = "done";
  } catch (err) {
    ctx.status = "idle";
    const message = err instanceof Error ? err.message : String(err);
    showToast(
      message.startsWith(CONSENT_REQUIRED_ERROR) ? "Download models from the popup first" : "Couldn't analyze this page",
    );
  }
  render();
}

void main();
