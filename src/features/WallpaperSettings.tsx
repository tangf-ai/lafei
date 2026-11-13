import { useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { AlertTriangle, Check, ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useUI, toast } from "../store/ui";
import { cn } from "../lib/util";
import type { WallpaperGlass } from "../types";
import {
  WALLPAPER_BLUR_MAX,
  WALLPAPER_BLUR_MIN,
  WALLPAPER_PRESETS,
  WALLPAPER_SCRIM_MAX,
  WALLPAPER_SCRIM_MIN,
  removeWallpaperImage,
  saveWallpaperImage,
  useWallpaperImage,
} from "../lib/wallpaper";

const GLASS_OPTIONS: Array<{ id: WallpaperGlass; label: string; caption: string }> = [
  { id: "clear", label: "通透", caption: "背景最明显" },
  { id: "balanced", label: "平衡", caption: "日常" },
  { id: "solid", label: "沉稳", caption: "文字最清楚" },
];

export function WallpaperSettings() {
  const wallpaper = useUI((state) => state.wallpaper);
  const setWallpaper = useUI((state) => state.setWallpaper);
  const hasAsset = Boolean(wallpaper.assetId);
  const customSelected = wallpaper.kind === "custom" && hasAsset;
  const custom = useWallpaperImage(wallpaper.assetId);
  const customUrl = custom.status === "ready" ? custom.url : null;
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const active = wallpaper.kind !== "none";

  const openPicker = () => fileRef.current?.click();

  // 已经有图时点一下直接换回来；正在用这张图时再点就是换一张
  const onCustomTile = () => {
    if (!hasAsset) {
      openPicker();
      return;
    }
    if (customSelected) {
      openPicker();
      return;
    }
    setWallpaper({ kind: "custom" });
  };

  const applyFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast("请选择 JPG / PNG / WebP 图片", "error");
      return;
    }
    setBusy(true);
    try {
      const previous = wallpaper.assetId;
      const assetId = await saveWallpaperImage(file);
      setWallpaper({ kind: "custom", assetId });
      if (previous && previous !== assetId) void removeWallpaperImage(previous);
      toast("背景已换上", "success");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      toast(
        reason === "too-large"
          ? "图片超过 32MB，换一张小一点的"
          : "这张图片读不出来，试试 JPG 或 PNG",
        "error",
      );
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const clearImage = () => {
    const assetId = wallpaper.assetId;
    // 从图库切到预设时移除图片，不要把当前预设一起关掉
    setWallpaper({ kind: wallpaper.kind === "custom" ? "none" : wallpaper.kind, assetId: null });
    void removeWallpaperImage(assetId);
    toast("已移除这张背景图");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void applyFile(file);
  };

  return (
    <div
      className={cn("settings-block wallpaper-block", dragging && "is-dragging")}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="settings-block-head">
        <div>
          <h3>背景</h3>
          <p>给整个工作台铺一张大背景，面板会变成磨砂玻璃。图片只保存在本机。</p>
        </div>
        <span className={cn("status-badge", active && "is-ok")}>
          <span className="status-dot" />
          {active ? "已启用" : "纯色"}
        </span>
      </div>

      <div className="wp-grid" role="group" aria-label="背景图">
        <button
          type="button"
          className={cn("wp-tile", "wp-tile-none", !active && "active")}
          onClick={() => setWallpaper({ kind: "none" })}
          aria-pressed={!active}
          title="不使用背景图，保持原来的纯色工作台"
        >
          <span className="wp-tile-preview" />
          <span className="wp-tile-foot">
            <span className="wp-tile-name">纯色</span>
            {!active && <Check size={11} className="wp-tile-check" />}
          </span>
        </button>

        {WALLPAPER_PRESETS.map((preset) => {
          const selected = wallpaper.kind === "preset" && wallpaper.preset === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={cn("wp-tile", selected && "active")}
              onClick={() => setWallpaper({ kind: "preset", preset: preset.id })}
              aria-pressed={selected}
              title={`${preset.label} · ${preset.caption}`}
            >
              <span className="wp-tile-preview" style={{ backgroundImage: preset.background }} />
              <span className="wp-tile-foot">
                <span className="wp-tile-name">{preset.label}</span>
                {selected && <Check size={11} className="wp-tile-check" />}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          className={cn("wp-tile", "wp-tile-custom", customSelected && "active")}
          onClick={onCustomTile}
          disabled={busy}
          aria-pressed={customSelected}
          title="选择本机图片（也可以把图片拖进这一块）"
        >
          <span
            className={cn("wp-tile-preview", !customUrl && "is-empty")}
            style={customUrl ? { backgroundImage: `url("${customUrl}")` } : undefined}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : customUrl ? (
              <span className="wp-custom-tag">{customSelected ? "更换" : "使用"}</span>
            ) : (
              <>
                <ImagePlus size={15} />
                <em>上传</em>
              </>
            )}
          </span>
          <span className="wp-tile-foot">
            <span className="wp-tile-name">自定义图片</span>
            {customSelected && <Check size={11} className="wp-tile-check" />}
          </span>
        </button>
      </div>

      {custom.status === "missing" && (
        <p className="wp-warning">
          <AlertTriangle size={12} /> 上次的图片已经找不到了，先显示预设。重新选一张即可。
        </p>
      )}

      {active && (
        <div className="wp-controls">
          <div className="wp-sliders">
            <label className="wp-slider">
              <span className="wp-slider-head">
                <b>背景模糊</b>
                <em>{wallpaper.blur === 0 ? "清晰" : `${wallpaper.blur}px`}</em>
              </span>
              <input
                type="range"
                min={WALLPAPER_BLUR_MIN}
                max={WALLPAPER_BLUR_MAX}
                step={1}
                value={wallpaper.blur}
                onChange={(event) => setWallpaper({ blur: Number(event.target.value) })}
                style={
                  {
                    "--wp-fill": `${
                      ((wallpaper.blur - WALLPAPER_BLUR_MIN) /
                        (WALLPAPER_BLUR_MAX - WALLPAPER_BLUR_MIN)) *
                      100
                    }%`,
                  } as CSSProperties
                }
                aria-label="背景模糊"
              />
            </label>

            <label className="wp-slider">
              <span className="wp-slider-head">
                <b>背景遮罩</b>
                <em>{Math.round(wallpaper.scrim * 100)}%</em>
              </span>
              <input
                type="range"
                min={WALLPAPER_SCRIM_MIN}
                max={WALLPAPER_SCRIM_MAX}
                step={0.01}
                value={wallpaper.scrim}
                onChange={(event) => setWallpaper({ scrim: Number(event.target.value) })}
                style={
                  {
                    "--wp-fill": `${
                      ((wallpaper.scrim - WALLPAPER_SCRIM_MIN) /
                        (WALLPAPER_SCRIM_MAX - WALLPAPER_SCRIM_MIN)) *
                      100
                    }%`,
                  } as CSSProperties
                }
                aria-label="背景遮罩浓度"
              />
            </label>
          </div>

          <div className="wp-options">
            <div className="wp-option">
              <span className="wp-option-label">
                面板
                <em>{GLASS_OPTIONS.find((item) => item.id === wallpaper.glass)?.caption}</em>
              </span>
              <div className="wp-segmented" role="group" aria-label="面板通透度">
                {GLASS_OPTIONS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={cn(wallpaper.glass === item.id && "is-active")}
                    onClick={() => setWallpaper({ glass: item.id })}
                    aria-pressed={wallpaper.glass === item.id}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="wp-option wp-option-frame">
              <span className="wp-option-label">
                四周留白
                <em>{wallpaper.frame === "float" ? "浮窗" : "铺满"}</em>
              </span>
              <button
                type="button"
                role="switch"
                aria-label="四周留白"
                aria-checked={wallpaper.frame === "float"}
                className={cn("wp-switch", wallpaper.frame === "float" && "is-on")}
                onClick={() =>
                  setWallpaper({ frame: wallpaper.frame === "float" ? "edge" : "float" })
                }
              >
                <span />
              </button>
            </div>
          </div>

          <div className="wp-foot">
            <p>面板越通透，背景越明显；字看不清时把遮罩调高一点。</p>
            {hasAsset && (
              <span className="wp-image-actions">
                <button type="button" onClick={openPicker}>
                  <ImagePlus size={11} /> 更换图片
                </button>
                <button type="button" onClick={clearImage}>
                  <Trash2 size={11} /> 移除
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="wp-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void applyFile(file);
        }}
      />
    </div>
  );
}
