import { useEffect, useLayoutEffect } from "react";
import { useUI } from "../store/ui";
import { useWallpaperImage, wallpaperPresetBackground } from "../lib/wallpaper";

/**
 * 全应用背景层：铺在壳层后面的一张「大背景」。
 * 图片或光雾由设置页决定；壳层在 data-wallpaper="on" 时切换成玻璃材质。
 */
export function WallpaperLayer() {
  const wallpaper = useUI((state) => state.wallpaper);

  const isCustom = wallpaper.kind === "custom" && Boolean(wallpaper.assetId);
  const custom = useWallpaperImage(isCustom ? wallpaper.assetId : null);
  const photoUrl = custom.status === "ready" ? custom.url : null;
  const missing = isCustom && custom.status === "missing";

  const active = wallpaper.kind === "preset" || (isCustom && custom.status !== "loading");
  const background = photoUrl ? `url("${photoUrl}")` : wallpaperPresetBackground(wallpaper.preset);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!active) {
      root.dataset.wallpaper = "off";
      delete root.dataset.wallpaperGlass;
      delete root.dataset.wallpaperFrame;
      root.style.removeProperty("--wp-blur");
      root.style.removeProperty("--wp-scrim");
      return;
    }
    root.dataset.wallpaper = "on";
    root.dataset.wallpaperGlass = wallpaper.glass;
    root.dataset.wallpaperFrame = wallpaper.frame;
    root.style.setProperty("--wp-blur", `${wallpaper.blur}px`);
    root.style.setProperty("--wp-scrim", String(wallpaper.scrim));
  }, [active, wallpaper.glass, wallpaper.frame, wallpaper.blur, wallpaper.scrim]);

  useEffect(
    () => () => {
      const root = document.documentElement;
      root.dataset.wallpaper = "off";
      delete root.dataset.wallpaperGlass;
      delete root.dataset.wallpaperFrame;
    },
    [],
  );

  if (!active) return null;

  return (
    <div className="app-wallpaper" aria-hidden="true" data-missing={missing ? "true" : undefined}>
      <div className="app-wallpaper-media" style={{ backgroundImage: background }} />
      <div className="app-wallpaper-tint" />
      <div className="app-wallpaper-glow" />
    </div>
  );
}
