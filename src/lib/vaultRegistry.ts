export interface VaultCounts {
  notes: number;
  tasks: number;
  chats: number;
}

export interface VaultEntry {
  root: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
  counts?: VaultCounts;
}

const STORAGE_KEY = "lafei:vaults:v1";
const MAX_VAULTS = 12;

export function vaultName(root: string) {
  return root.split(/[\\/]/).filter(Boolean).pop() || root;
}

function normalize(list: unknown): VaultEntry[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const entries: VaultEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const value = item as Partial<VaultEntry>;
    if (typeof value.root !== "string" || !value.root.trim() || seen.has(value.root)) continue;
    seen.add(value.root);
    entries.push({
      root: value.root,
      name: typeof value.name === "string" && value.name.trim() ? value.name : vaultName(value.root),
      addedAt: typeof value.addedAt === "number" ? value.addedAt : Date.now(),
      lastOpenedAt: typeof value.lastOpenedAt === "number" ? value.lastOpenedAt : Date.now(),
      counts:
        value.counts &&
        typeof value.counts.notes === "number" &&
        typeof value.counts.tasks === "number" &&
        typeof value.counts.chats === "number"
          ? value.counts
          : undefined,
    });
  }
  return entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, MAX_VAULTS);
}

export function loadVaults(): VaultEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

function saveVaults(entries: VaultEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(entries)));
  } catch {
    // 存储不可用时只影响最近目录列表，不影响数据本身
  }
}

export function rememberVault(root: string, counts?: VaultCounts): VaultEntry[] {
  const entries = loadVaults();
  const existing = entries.find((entry) => entry.root === root);
  const now = Date.now();
  if (existing) {
    existing.name = existing.name || vaultName(root);
    existing.lastOpenedAt = now;
    if (counts) existing.counts = counts;
  } else {
    entries.unshift({
      root,
      name: vaultName(root),
      addedAt: now,
      lastOpenedAt: now,
      counts,
    });
  }
  const next = normalize(entries);
  saveVaults(next);
  return next;
}

/**
 * 同步完成后刷新「最近的数据目录」里的数量。
 * 之前这些数字只在首次接入 / 切换仓库时写一次，之后一直停在旧值（例如一直显示 0 个任务），
 * 看起来像任务没有同步过去。
 */
export function updateVaultCounts(root: string, counts: VaultCounts): VaultEntry[] {
  const entries = loadVaults();
  const existing = entries.find((entry) => entry.root === root);
  if (!existing) return entries;
  const { notes, tasks, chats } = counts;
  if (
    existing.counts &&
    existing.counts.notes === notes &&
    existing.counts.tasks === tasks &&
    existing.counts.chats === chats
  ) {
    return entries;
  }
  existing.counts = { notes, tasks, chats };
  const next = normalize(entries);
  saveVaults(next);
  return next;
}

export function touchVault(root: string, counts?: VaultCounts): VaultEntry[] {
  return rememberVault(root, counts);
}

export function forgetVault(root: string): VaultEntry[] {
  const next = loadVaults().filter((entry) => entry.root !== root);
  saveVaults(next);
  return next;
}
