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
import { FLAGGED_THRESHOLD, toDisplayProbability } from "@/src/shared/thresholds";
import { brandMark } from "@/src/ui/icons";
import { mountToastHost, showToast } from "@/src/ui/toast";
import { CONSENT_REQUIRED_ERROR } from "@/src/shared/messages";
import { transcriptSection } from "@/src/ui/transcriptSection";
import { parseUnreadable, unreadableMessage, type UnreadableKind } from "@/src/shared/unreadable";
import { deepCheckRequestFields, deepDownloadStatus, isDeepResult, DEEP_CHECK_TOOLTIP } from "@/src/ui/deepCheck";

interface Ctx {
  settings: Settings;
  tabId: number | null;
  result: AnalyzeResult | null;
  status: TabAnalysisStatus["state"];
  /** Deep check (docs/plan.md "Two tiers"): the ↻ button's own busy/spin state. */
  deepBusy: boolean;
  deepChecklistOpen: boolean;
  /** Sentence text for the flagged list, keyed "blockId#index" (fetched from the page). */
  texts: Map<string, string>;
  /** A PDF or protected page: one quiet line instead of "Analyze page". */
  unreadable: UnreadableKind | null;
}

const ctx: Ctx = { settings: await getSettings(), tabId: null, result: null, status: "idle", deepBusy: false, deepChecklistOpen: false, texts: new Map(), unreadable: null };
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
  ctx.unreadable = null;
  if (ctx.tabId !== null) {
    const tabId = ctx.tabId;
    sendTabMessage(tabId, "getPageType", undefined)
      .then((v) => {
        if (v.pdf && ctx.tabId === tabId) {
          ctx.unreadable = "pdf";
          render();
        }
      })
      .catch(() => {});
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
  if (status.state === "error") ctx.unreadable = parseUnreadable(status.error) ?? ctx.unreadable;
  if (status.state === "done") {
    ctx.result = status.result;
    void loadTexts(status.result);
  }
}

/** Fetches the flagged sentences' text from the page, so the list reads as sentences, not ids. */
async function loadTexts(result: AnalyzeResult): Promise<void> {
  if (ctx.tabId === null) return;
  const keys = result.sentences.filter((s) => s.score >= FLAGGED_THRESHOLD).map((s) => ({ blockId: s.blockId, index: s.index }));
  if (!keys.length) return;
  try {
    const { texts } = await sendTabMessage(ctx.tabId, "getSentenceTexts", { keys });
    ctx.texts = new Map(keys.flatMap((k, i) => (texts[i] ? [[`${k.blockId}#${k.index}`, texts[i]!] as [string, string]] : [])));
    render();
  } catch {
    // older content script: keep the fallback labels
  }
}

/** A sentence's shown P(AI): the run's per-item (paragraph-level) curve. */
function sentencePercent(result: AnalyzeResult, score: number): string {
  const p = toDisplayProbability(score, {
    detectors: result.detectors?.map((d) => d.id),
    method: result.fusion?.method,
    device: result.device,
    level: "unit",
  });
  return `${Math.round(p * 100)}%`;
}

function render(): void {
  clearChildren(root);
  root.append(
    h("header", { class: "sp-header" }, brandMark(), h("h1", null, "Local AI Detector")),
    ctx.tabId === null ? renderEmpty("No page to report on.") : renderBody(),
  );
  if (ctx.tabId !== null) root.append(transcriptSection(ctx.tabId));
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
  if (!ctx.result && ctx.unreadable) {
    body.append(renderEmpty(unreadableMessage(ctx.unreadable)));
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
      isDeepResult(result) ? h("span", { class: "sp-deep-tag" }, "Deep") : null,
      h(
        "button",
        {
          class: `icon-btn${ctx.deepBusy ? " is-spinning" : ""}`,
          type: "button",
          "aria-label": "Deep check",
          title: DEEP_CHECK_TOOLTIP,
          disabled: ctx.deepBusy,
          onclick: () => void onDeepCheck(),
        },
        "↻",
      ),
    ),
  );
  const flagged = result.sentences.filter((s) => s.score >= FLAGGED_THRESHOLD);
  if (flagged.length === 0) {
    body.append(renderEmpty("Nothing flagged."));
  } else {
    const list = h("ul", { class: "sp-list" });
    for (const s of flagged) {
      // List markers ("1.", "2.") split off as their own "sentences": not worth a row.
      const text = ctx.texts.get(`${s.blockId}#${s.index}`);
      if (text !== undefined && text.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length < 2) continue;
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
          h("span", { class: "sp-item-score" }, sentencePercent(result, s.score)),
          h("span", { class: "sp-item-label" }, text ?? `Sentence ${s.index + 1}`),
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
    void loadTexts(result);
    ctx.status = "done";
  } catch (err) {
    ctx.status = "idle";
    const message = err instanceof Error ? err.message : String(err);
    ctx.unreadable = parseUnreadable(err);
    if (!ctx.unreadable) showToast(
      message.startsWith(CONSENT_REQUIRED_ERROR) ? "Download models from the popup first" : "Couldn't analyze this page",
    );
  }
  render();
}

/** Deep check (docs/plan.md "Two tiers"): the side panel's ↻, next to the summary. */
async function onDeepCheck(): Promise<void> {
  const tabId = ctx.tabId;
  if (tabId === null) return;
  const status = deepDownloadStatus(ctx.settings, "wasm", undefined);
  if (!status.cached && !ctx.deepChecklistOpen) {
    ctx.deepChecklistOpen = true;
    const mb = status.missingBytes !== null ? `${Math.round(status.missingBytes / 1e6)} MB` : "some models";
    showToast(`Deep check needs to download ${mb} -- click ↻ again to proceed`);
    return;
  }
  ctx.deepChecklistOpen = false;
  ctx.deepBusy = true;
  render();
  try {
    const result = await sendMessage("analyzeTab", { tabId, target: "page", ...deepCheckRequestFields(ctx.settings) });
    ctx.result = result;
    void loadTexts(result);
    ctx.status = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (parseUnreadable(err)) ctx.unreadable = parseUnreadable(err);
    else
      showToast(
        message.startsWith(CONSENT_REQUIRED_ERROR) ? "Download models from the popup first" : "Couldn't run the deep check",
      );
  } finally {
    ctx.deepBusy = false;
    render();
  }
}

void main();
