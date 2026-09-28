// Pure helpers behind the options page's Presence controls, so the preset,
// the individual toggles and the per-site rules can't contradict each other.

import { isPresenceCustom, type AutoRunPolicy, type Presence, type Settings } from "../shared/settings";

/** What the Presence select shows: the preset, or "custom" once a toggle below was changed. */
export function presenceSelectValue(settings: Pick<Settings, "presence" | "autoRunPolicy" | "surfaces">): Presence | "custom" {
  return isPresenceCustom(settings) ? "custom" : settings.presence;
}

/** "https://Example.com/path" -> "example.com"; "" when there's no host. */
export function normalizeHost(input: string): string {
  const s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  return s.replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Auto-run choices the UI offers. "ask" was never implemented (it behaved as "never"). */
export const AUTO_RUN_CHOICES: AutoRunPolicy[] = ["always", "never"];

/** The toolbar icon opens the side panel (instead of the popup). */
export function sidePanelOnIconClick(settings: Pick<Settings, "surfaces">): boolean {
  return settings.surfaces?.sidePanel === true;
}

/** Popup's "Show on page": offered when nothing paints results on the page automatically. */
export function offerShowOnPage(settings: Pick<Settings, "surfaces">): boolean {
  return !settings.surfaces.highlights && !settings.surfaces.chip;
}
