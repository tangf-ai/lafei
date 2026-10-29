/**
 * 挂在 body 上的独立浮层（例如标签候选）在 DOM 上并不在触发它的容器里，
 * 外层浮层的「点外面关闭」判定需要认一下这个标记，否则点候选项会把外层浮层一起关掉。
 */
export const FLOATING_LAYER_ATTR = "data-floating-layer";

export function inFloatingLayer(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(`[${FLOATING_LAYER_ATTR}]`));
}
