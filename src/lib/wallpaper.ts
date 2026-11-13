import { useEffect, useState } from "react";
import { db } from "../db";
import type {
  WallpaperGlass,
  WallpaperKind,
  WallpaperPreset,
  WallpaperSettings,
} from "../types";

export interface WallpaperPresetItem {
  id: WallpaperPreset;
  label: string;
  caption: string;
  /** 多层径向渐变，纯 CSS，离线可用，也作为设置页的色板预览 */
  background: string;
}

/**
 * 内置的「光雾」背景：不是照片，而是一层柔光，和大面积留白的界面同一语气。
 * 全部用 CSS 渐变画出来，不依赖网络，也不占安装包体积。
 */
export const WALLPAPER_PRESETS: WallpaperPresetItem[] = [
  {
    id: "dawn",
    label: "晨雾",
    caption: "米白 · 苔绿",
    background:
      "radial-gradient(120% 90% at 6% 0%, #f6ecd9 0%, rgba(246,236,217,0) 52%)," +
      "radial-gradient(85% 70% at 96% 10%, #e3b89b 0%, rgba(227,184,155,0) 58%)," +
      "radial-gradient(95% 85% at 62% 104%, #b3c9a6 0%, rgba(179,201,166,0) 64%)," +
      "linear-gradient(150deg, #ecdfc9 0%, #e4ddc5 48%, #d5e0c6 100%)"
  },
  {
    id: "moss",
    label: "苔原",
    caption: "浅绿 · 林间",
    background:
      "radial-gradient(115% 90% at 10% -6%, #e9f0dd 0%, rgba(233,240,221,0) 52%)," +
      "radial-gradient(75% 65% at 94% 8%, #9fbd92 0%, rgba(159,189,146,0) 60%)," +
      "radial-gradient(105% 85% at 42% 106%, #6f9567 0%, rgba(111,149,103,0) 66%)," +
      "linear-gradient(155deg, #d3e3c7 0%, #bdd3ae 52%, #a6c096 100%)"
  },
  {
    id: "dune",
    label: "沙丘",
    caption: "暖沙 · 纸感",
    background:
      "radial-gradient(115% 85% at 8% -2%, #f7e9cf 0%, rgba(247,233,207,0) 52%)," +
      "radial-gradient(80% 70% at 92% 12%, #d9b883 0%, rgba(217,184,131,0) 60%)," +
      "radial-gradient(100% 85% at 55% 104%, #bd9557 0%, rgba(189,149,87,0) 64%)," +
      "linear-gradient(155deg, #eddbb9 0%, #e0c69a 52%, #d2b280 100%)"
  },
  {
    id: "coast",
    label: "海岸",
    caption: "雾蓝 · 清透",
    background:
      "radial-gradient(120% 90% at 12% 0%, #e7f2f3 0%, rgba(231,242,243,0) 52%)," +
      "radial-gradient(85% 70% at 92% 8%, #a6c9d0 0%, rgba(166,201,208,0) 60%)," +
      "radial-gradient(95% 85% at 52% 106%, #7aa4ae 0%, rgba(122,164,174,0) 64%)," +
      "linear-gradient(150deg, #d6e9eb 0%, #c2dce0 52%, #aacbd2 100%)"
  },
  {
    id: "ember",
    label: "暮橘",
    caption: "陶土 · 黄昏",
    background:
      "radial-gradient(110% 85% at 8% 0%, #f7e3cf 0%, rgba(247,227,207,0) 52%)," +
      "radial-gradient(85% 70% at 94% 12%, #e0aa82 0%, rgba(224,170,130,0) 60%)," +
      "radial-gradient(100% 85% at 48% 104%, #c47f58 0%, rgba(196,127,88,0) 62%)," +
      "linear-gradient(150deg, #f0d5bd 0%, #e4bb9b 52%, #d5a179 100%)"
  },
  {
    id: "slate",
    label: "砚青",
    caption: "冷灰 · 安静",
    background:
      "radial-gradient(120% 90% at 6% 0%, #eaf0ec 0%, rgba(234,240,236,0) 52%)," +
      "radial-gradient(85% 70% at 92% 8%, #aec1bb 0%, rgba(174,193,187,0) 60%)," +
      "radial-gradient(95% 85% at 52% 106%, #849b95 0%, rgba(132,155,149,0) 62%)," +
      "linear-gradient(155deg, #dbe5e0 0%, #c8d6d0 52%, #b4c6bf 100%)"
  },
];

export const WALLPAPER_BLUR_MIN = 0;
export const WALLPAPER_BLUR_MAX = 40;
export const WALLPAPER_SCRIM_MIN = 0;
export const WALLPAPER_SCRIM_MAX = 0.7;
export const WALLPAPER_IMAGE_MAX_EDGE = 3200;
export const WALLPAPER_IMAGE_MAX_BYTES = 32 * 1024 * 1024;

export const WALLPAPER_DEFAULT: WallpaperSettings = {
  kind: "none",
  preset: "dawn",
  assetId: null,
  blur: 12,
  scrim: 0.24,
  glass: "clear",
  frame: "float",
};

const KINDS: WallpaperKind[] = ["none", "preset", "custom"];
const GLASS: WallpaperGlass[] = ["clear", "balanced", "solid"];

export function clampWallpaper(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeWallpaper(input?: Partial<WallpaperSettings> | null): WallpaperSettings {
  const saved = input ?? {};
  const preset = WALLPAPER_PRESETS.find((item) => item.id === saved.preset)?.id ?? WALLPAPER_DEFAULT.preset;
  const kind = KINDS.includes(saved.kind as WallpaperKind)
    ? (saved.kind as WallpaperKind)
    : WALLPAPER_DEFAULT.kind;
  const assetId = typeof saved.assetId === "string" && saved.assetId ? saved.assetId : null;
  return {
    kind: kind === "custom" && !assetId ? "preset" : kind,
    preset,
    assetId,
    blur: Math.round(
      clampWallpaper(
        typeof saved.blur === "number" ? saved.blur : WALLPAPER_DEFAULT.blur,
        WALLPAPER_BLUR_MIN,
        WALLPAPER_BLUR_MAX,
      ),
    ),
    scrim: Number(
      clampWallpaper(
        typeof saved.scrim === "number" ? saved.scrim : WALLPAPER_DEFAULT.scrim,
        WALLPAPER_SCRIM_MIN,
        WALLPAPER_SCRIM_MAX,
      ).toFixed(2),
    ),
    glass: GLASS.includes(saved.glass as WallpaperGlass)
      ? (saved.glass as WallpaperGlass)
      : WALLPAPER_DEFAULT.glass,
    frame: saved.frame === "edge" ? "edge" : "float",
  };
}

export function wallpaperPreset(id: WallpaperPreset): WallpaperPresetItem {
  return WALLPAPER_PRESETS.find((item) => item.id === id) ?? WALLPAPER_PRESETS[0];
}

/** 背景层可以直接用的 CSS background（自定义图片走 object URL，不在这里） */
export function wallpaperPresetBackground(id: WallpaperPreset) {
  return wallpaperPreset(id).background;
}

/* ---------- 本机图片素材 ---------- */

const urlCache = new Map<string, string>();
const urlPending = new Map<string, Promise<string | null>>();

async function loadAssetUrl(assetId: string): Promise<string | null> {
  const cached = urlCache.get(assetId);
  if (cached) return cached;
  const pending = urlPending.get(assetId);
  if (pending) return pending;
  const task = (async () => {
    try {
      const asset = await db.assets.get(assetId);
      if (!asset?.blob) return null;
      const url = URL.createObjectURL(asset.blob);
      urlCache.set(assetId, url);
      return url;
    } catch {
      return null;
    } finally {
      urlPending.delete(assetId);
    }
  })();
  urlPending.set(assetId, task);
  return task;
}

/** 把用户图片缩到最长边 3200px 再存，避免几千万像素的原图撑爆本机存储 */
export async function saveWallpaperImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("unsupported");
  if (file.size > WALLPAPER_IMAGE_MAX_BYTES) throw new Error("too-large");

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.decoding = "async";
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("decode"));
      element.src = sourceUrl;
    });

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) throw new Error("decode");

    const scale = Math.min(1, WALLPAPER_IMAGE_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");

    // JPEG 没有透明通道：透明 PNG 先铺一层主题底色，避免保存后变成黑底
    const tint =
      getComputedStyle(document.documentElement).getPropertyValue("--wall-tint").trim() || "#f3f4f0";
    context.fillStyle = tint;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), "image/jpeg", 0.86);
    });
    if (!blob) throw new Error("encode");

    const id = `wp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await db.assets.put({ id, blob, width, height, createdAt: Date.now() });
    // 立刻把新图的 object URL 放进缓存：换图后的第一帧就能拿到新图，不会闪回纯色
    urlCache.set(id, URL.createObjectURL(blob));
    return id;
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export async function removeWallpaperImage(assetId: string | null) {
  if (!assetId) return;
  const url = urlCache.get(assetId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(assetId);
  }
  try {
    await db.assets.delete(assetId);
  } catch {
    // 素材已经不存在时不用打扰用户
  }
}

export type WallpaperImageStatus = "idle" | "loading" | "ready" | "missing";

/** 读取自定义背景的 object URL；组件卸载或换图时不会重复解码 */
export function useWallpaperImage(assetId: string | null): {
  url: string | null;
  status: WallpaperImageStatus;
} {
  const [state, setState] = useState<{
    id: string | null;
    url: string | null;
    status: WallpaperImageStatus;
  }>(() => {
    if (!assetId) return { id: null, url: null, status: "idle" };
    const cached = urlCache.get(assetId);
    return { id: assetId, url: cached ?? null, status: cached ? "ready" : "loading" };
  });

  useEffect(() => {
    if (!assetId) {
      setState({ id: null, url: null, status: "idle" });
      return;
    }
    const cached = urlCache.get(assetId);
    if (cached) {
      setState({ id: assetId, url: cached, status: "ready" });
      return;
    }
    let cancelled = false;
    setState({ id: assetId, url: null, status: "loading" });
    void loadAssetUrl(assetId).then((next) => {
      if (cancelled) return;
      setState({ id: assetId, url: next, status: next ? "ready" : "missing" });
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  // 状态可能还停在上一个 assetId 上：只要不属于当前 id，就按「加载中」处理，
  // 避免换图 / 删图后的第一帧拿旧 URL 画一次。
  const cached = assetId ? urlCache.get(assetId) : null;
  if (cached) return { url: cached, status: "ready" };
  if (!assetId) return { url: null, status: "idle" };
  if (state.id !== assetId) return { url: null, status: "loading" };
  return { url: state.url, status: state.status };
}
