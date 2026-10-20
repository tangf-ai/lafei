import type { StoreFile } from "./folderFormat";

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export const folderBackend = {
  async pickFolder(): Promise<string | null> {
    return invoke<string | null>("pick_store_folder");
  },
  async prepare(selected: string): Promise<string> {
    return invoke<string>("prepare_store", { selected });
  },
  async readFiles(root: string): Promise<StoreFile[]> {
    return invoke<StoreFile[]>("read_store_files", { root });
  },
  async readManifest(root: string): Promise<string | null> {
    return invoke<string | null>("read_store_manifest", { root });
  },
  async writeFile(root: string, path: string, contents: string): Promise<void> {
    return invoke<void>("write_store_file", { root, path, contents });
  },
  async removeFile(root: string, path: string): Promise<void> {
    return invoke<void>("remove_store_file", { root, path });
  },
  async clearData(root: string): Promise<void> {
    return invoke<void>("clear_store_data", { root });
  },
};
