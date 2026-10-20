import type { FontScale } from "../types";
import { isTauri } from "./util";

export const FONT_SCALES: Array<{ value: FontScale; label: string; caption: string; sample: number }> = [
  { value: 0.9, label: "小", caption: "90%", sample: 14 },
  { value: 1, label: "标准", caption: "100%", sample: 16 },
  { value: 1.1, label: "大", caption: "110%", sample: 19 },
  { value: 1.2, label: "特大", caption: "120%", sample: 22 },
];

function applyWebZoom(scale: FontScale) {
  document.documentElement.style.setProperty("zoom", String(scale));
}

export function applyFontScale(scale: FontScale) {
  document.documentElement.dataset.fontScale = String(scale);
  document.documentElement.style.removeProperty("zoom");

  if (isTauri) {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(scale))
      .catch(() => applyWebZoom(scale));
    return;
  }

  applyWebZoom(scale);
}
