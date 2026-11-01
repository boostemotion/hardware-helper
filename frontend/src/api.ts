export type CatalogItem = {
  id: number;
  category: string;
  name: string;
  price: number;
  specs: string;
  capacity_tb: number;
  power_w: number;
  notes: string;
  updated_at: string;
};

export type BuildItem = {
  id?: number;
  build_id?: number;
  catalog_item_id?: number | null;
  category: string;
  name: string;
  quantity: number;
  unit_price: number;
  specs: string;
  capacity_tb: number;
  power_w: number;
  notes: string;
  total?: number;
  total_power_w?: number;
  total_capacity_tb?: number;
};

export type Build = {
  id: number;
  name: string;
  kind: string;
  notes: string;
  created_at: string;
  updated_at: string;
  items: BuildItem[];
  total: number;
  total_power_w: number;
  total_capacity_tb: number;
  disk_count: number;
};

export type BuildDraft = {
  name: string;
  kind: string;
  notes: string;
  items: BuildItem[];
};

export type CpuSuggestion = {
  name: string;
  model: string;
  vendor: string;
  cores: number;
  threads: number;
  igpu: string;
  tdp_w: number | null;
  specs: string;
  source: string;
  source_url: string;
};

export type GpuSuggestion = {
  name: string;
  vendor: string;
  gpu_name: string;
  architecture: string;
  generation: string;
  memory_size_gb: number | null;
  memory_type: string;
  memory_bus: number | null;
  tdp_w: number | null;
  suggested_psu_w: number | null;
  bus_interface: string;
  specs: string;
  source: string;
  source_url: string;
};

export type CategoryMeta = {
  name: string;
  storage: boolean;
  power: boolean;
};

export type BackupExport = {
  version: number;
  exported_at: string;
  categories: CategoryMeta[];
  catalog_items: CatalogItem[];
  builds: Build[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 只有带 body 的请求才需要 Content-Type；给 GET 也加上会触发 CORS 预检。
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  categories: () => request<CategoryMeta[]>("/catalog/categories"),
  catalog: (category?: string, q?: string) => {
    const params = new URLSearchParams();
    if (category && category !== "全部") params.set("category", category);
    if (q) params.set("q", q);
    const query = params.toString();
    return request<CatalogItem[]>(`/catalog${query ? `?${query}` : ""}`);
  },
  createCatalog: (item: Omit<CatalogItem, "id" | "updated_at">) =>
    request<CatalogItem>("/catalog", { method: "POST", body: JSON.stringify(item) }),
  updateCatalog: (id: number, item: Omit<CatalogItem, "id" | "updated_at">) =>
    request<CatalogItem>(`/catalog/${id}`, { method: "PUT", body: JSON.stringify(item) }),
  deleteCatalog: (id: number) => request<{ ok: boolean }>(`/catalog/${id}`, { method: "DELETE" }),
  builds: () => request<Build[]>("/builds"),
  build: (id: number) => request<Build>(`/builds/${id}`),
  createBuild: (draft: BuildDraft) => request<Build>("/builds", { method: "POST", body: JSON.stringify(draft) }),
  updateBuild: (id: number, draft: BuildDraft) => request<Build>(`/builds/${id}`, { method: "PUT", body: JSON.stringify(draft) }),
  deleteBuild: (id: number) => request<{ ok: boolean }>(`/builds/${id}`, { method: "DELETE" }),
  compare: (ids: number[]) => request<Build[]>(`/compare?ids=${ids.join(",")}`),
  exportData: () => request<BackupExport>("/export"),
  cpuLookup: (q: string) => request<CpuSuggestion[]>(`/cpu/lookup?q=${encodeURIComponent(q)}`),
  refreshCpu: () => request<{ ok: boolean; count: number; updated_at: string }>("/cpu/refresh", { method: "POST" }),
  gpuLookup: (q: string) => request<GpuSuggestion[]>(`/gpu/lookup?q=${encodeURIComponent(q)}`),
  refreshGpu: () => request<{ ok: boolean; count: number; updated_at: string }>("/gpu/refresh", { method: "POST" }),
  health: () => request<{ status: string }>("/health"),
};
