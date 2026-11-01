import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowRight,
  Check,
  Database,
  Download,
  FilePlus2,
  GitCompareArrows,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api, Build, BuildDraft, BuildItem, CatalogItem, CategoryMeta, CpuSuggestion, GpuSuggestion } from "./api";

type View = "saved" | "editor" | "catalog" | "compare";

const kinds = ["通用整机", "低功耗 / NAS", "性能整机", "低成本二手", "工作站"];
const storageCategories = new Set(["SSD", "硬盘"]);
const powerCategories = new Set(["CPU", "主板", "内存", "显卡", "SSD", "硬盘", "HBA卡", "网卡", "电源", "散热"]);

function isStorageCategory(category: string) {
  return storageCategories.has(category);
}

function hasPowerField(category: string) {
  return powerCategories.has(category);
}

function specsPlaceholder(category: string) {
  if (category === "CPU") return "自动识别核心、线程、核显，也可补充频率/缓存";
  if (category === "显卡") return "自动识别显存、架构、位宽，也可补充接口/散热";
  if (category === "SSD") return "例如：NVMe PCIe 4.0，读写速度";
  if (category === "硬盘") return "例如：企业级机械硬盘，转速/健康度";
  return "规格、接口、尺寸或兼容性说明";
}

type CpuHint = {
  aliases: string[];
  cores: number;
  threads: number;
  igpu: string;
  tdp_w: number;
};

const cpuHints: CpuHint[] = [
  { aliases: ["n100"], cores: 4, threads: 4, igpu: "Intel UHD Graphics（24EU）", tdp_w: 6 },
  { aliases: ["n95"], cores: 4, threads: 4, igpu: "Intel UHD Graphics（24EU）", tdp_w: 15 },
  { aliases: ["n97"], cores: 4, threads: 4, igpu: "Intel UHD Graphics（32EU）", tdp_w: 12 },
  { aliases: ["j4125"], cores: 4, threads: 4, igpu: "Intel UHD Graphics 600", tdp_w: 10 },
  { aliases: ["j6412"], cores: 4, threads: 4, igpu: "Intel UHD Graphics", tdp_w: 10 },
  { aliases: ["g4600"], cores: 2, threads: 4, igpu: "Intel HD Graphics 630", tdp_w: 51 },
  { aliases: ["i3-8100t", "i3-8100"], cores: 4, threads: 4, igpu: "Intel UHD Graphics 630", tdp_w: 35 },
  { aliases: ["i5-7500"], cores: 4, threads: 4, igpu: "Intel HD Graphics 630", tdp_w: 65 },
  { aliases: ["i5-8500t"], cores: 6, threads: 6, igpu: "Intel UHD Graphics 630", tdp_w: 35 },
  { aliases: ["i5-10400"], cores: 6, threads: 12, igpu: "Intel UHD Graphics 630", tdp_w: 65 },
  { aliases: ["i5-12400"], cores: 6, threads: 12, igpu: "Intel UHD Graphics 730", tdp_w: 65 },
  { aliases: ["i5-12500t"], cores: 6, threads: 12, igpu: "Intel UHD Graphics 770", tdp_w: 35 },
  { aliases: ["i7-8700"], cores: 6, threads: 12, igpu: "Intel UHD Graphics 630", tdp_w: 65 },
  { aliases: ["i7-12700"], cores: 12, threads: 20, igpu: "Intel UHD Graphics 770", tdp_w: 65 },
  { aliases: ["3200g"], cores: 4, threads: 4, igpu: "AMD Radeon Vega 8", tdp_w: 65 },
  { aliases: ["3400g"], cores: 4, threads: 8, igpu: "AMD Radeon Vega 11", tdp_w: 65 },
  { aliases: ["4650g"], cores: 6, threads: 12, igpu: "AMD Radeon Vega 7", tdp_w: 65 },
  { aliases: ["4750g"], cores: 8, threads: 16, igpu: "AMD Radeon Vega 8", tdp_w: 65 },
  { aliases: ["5600g"], cores: 6, threads: 12, igpu: "AMD Radeon Vega 7", tdp_w: 65 },
  { aliases: ["5700g"], cores: 8, threads: 16, igpu: "AMD Radeon Vega 8", tdp_w: 65 },
];

function normalizeCpuModel(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function findCpuHint(value: string): CpuHint | null {
  const model = normalizeCpuModel(value);
  if (model.length < 4) return null;
  return cpuHints.find((hint) => hint.aliases.some((alias) => {
    const normalizedAlias = normalizeCpuModel(alias);
    return model.includes(normalizedAlias) || normalizedAlias.includes(model);
  })) ?? null;
}

function cpuHintSpecs(hint: CpuHint) {
  return `${hint.cores}核 / ${hint.threads}线程 · ${hint.igpu} 核显`;
}

const emptyDraft = (): BuildDraft => ({ name: "未命名方案", kind: "通用整机", notes: "", items: [] });

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value || 0);
}

function decimal(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value || 0);
}

function toDraft(build: Build): BuildDraft {
  return { name: build.name, kind: build.kind, notes: build.notes, items: build.items.map((item) => ({ ...item })) };
}

function App() {
  const [view, setView] = useState<View>("saved");
  const [categories, setCategories] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [selectedBuildId, setSelectedBuildId] = useState<number | null>(null);
  const [draft, setDraft] = useState<BuildDraft>(emptyDraft());
  const [catalogCategory, setCatalogCategory] = useState("全部");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogForm, setCatalogForm] = useState<Omit<CatalogItem, "id" | "updated_at">>({
    category: "CPU",
    name: "",
    price: 0,
    specs: "",
    capacity_tb: 0,
    power_w: 0,
    notes: "",
  });
  const [editingCatalogId, setEditingCatalogId] = useState<number | null>(null);
  const [cpuHint, setCpuHint] = useState<CpuHint | null>(null);
  const [autoCpuSpecs, setAutoCpuSpecs] = useState("");
  const [autoCpuPower, setAutoCpuPower] = useState(0);
  const [cpuSuggestions, setCpuSuggestions] = useState<CpuSuggestion[]>([]);
  const [cpuLookupLoading, setCpuLookupLoading] = useState(false);
  const [gpuSuggestions, setGpuSuggestions] = useState<GpuSuggestion[]>([]);
  const [gpuLookupLoading, setGpuLookupLoading] = useState(false);
  const [selectedCatalogIds, setSelectedCatalogIds] = useState<number[]>([]);
  const [compareSelection, setCompareSelection] = useState<number[]>([]);
  const [compareBuilds, setCompareBuilds] = useState<Build[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const skipCpuLookupRef = useRef(false);
  const skipGpuLookupRef = useRef(false);
  const prevCategoryRef = useRef(catalogForm.category);

  const notify = (message: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 3000);
  };

  const loadCatalog = async () => {
    setCatalog(await api.catalog());
  };

  const loadBuilds = async (selectFirst = false) => {
    const nextBuilds = await api.builds();
    setBuilds(nextBuilds);
    if (selectFirst && nextBuilds.length > 0) {
      setSelectedBuildId(nextBuilds[0].id);
      setDraft(toDraft(nextBuilds[0]));
    }
  };

  const downloadExport = async () => {
    try {
      const payload = await api.exportData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `builddesk-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify("已导出备份文件");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败");
    }
  };

  const applyCategoryMeta = (rows: CategoryMeta[]) => {
    // 分类规则以后端为准；接口没带这两个字段时保留本地默认集合。
    if (rows.every((row) => typeof row.storage === "boolean" && typeof row.power === "boolean")) {
      storageCategories.clear();
      powerCategories.clear();
      rows.forEach((row) => {
        if (row.storage) storageCategories.add(row.name);
        if (row.power) powerCategories.add(row.name);
      });
    }
    setCategories(rows.map((row) => row.name));
  };

  useEffect(() => {
    Promise.all([api.categories(), api.catalog(), api.builds()])
      .then(([categoryRows, catalogRows, buildRows]) => {
        applyCategoryMeta(categoryRows);
        setCatalog(catalogRows);
        setBuilds(buildRows);
        if (buildRows.length > 0) {
          setSelectedBuildId(buildRows[0].id);
          setDraft(toDraft(buildRows[0]));
        }
        setStatus("ready");
      })
      .catch(() => setStatus("offline"));
  }, []);

  useEffect(() => {
    if (compareSelection.length === 0) {
      setCompareBuilds([]);
      return;
    }
    api.compare(compareSelection).then(setCompareBuilds).catch(() => notify("方案对比加载失败"));
  }, [compareSelection]);

  useEffect(() => {
    if (skipCpuLookupRef.current) {
      skipCpuLookupRef.current = false;
      return;
    }
    const query = catalogForm.category === "CPU" ? catalogForm.name.trim() : "";
    if (query.length < 3) {
      setCpuSuggestions([]);
      setCpuLookupLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setCpuLookupLoading(true);
      try {
        const suggestions = await api.cpuLookup(query);
        if (!cancelled) setCpuSuggestions(suggestions);
      } catch {
        if (!cancelled) setCpuSuggestions([]);
      } finally {
        if (!cancelled) setCpuLookupLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [catalogForm.category, catalogForm.name]);

  useEffect(() => {
    if (skipGpuLookupRef.current) {
      skipGpuLookupRef.current = false;
      return;
    }
    const query = catalogForm.category === "显卡" ? catalogForm.name.trim() : "";
    if (query.length < 2) {
      setGpuSuggestions([]);
      setGpuLookupLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setGpuLookupLoading(true);
      try {
        const suggestions = await api.gpuLookup(query);
        if (!cancelled) setGpuSuggestions(suggestions);
      } catch {
        if (!cancelled) setGpuSuggestions([]);
      } finally {
        if (!cancelled) setGpuLookupLoading(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [catalogForm.category, catalogForm.name]);

  const filteredCatalog = useMemo(() => {
    const keyword = catalogSearch.trim().toLowerCase();
    return catalog.filter((item) => {
      const matchCategory = catalogCategory === "全部" || item.category === catalogCategory;
      const matchSearch = !keyword || `${item.name} ${item.specs} ${item.notes}`.toLowerCase().includes(keyword);
      return matchCategory && matchSearch;
    });
  }, [catalog, catalogCategory, catalogSearch]);
  const planTotal = draft.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const planPower = draft.items.reduce((sum, item) => sum + item.quantity * item.power_w, 0);
  const planCapacity = draft.items.reduce((sum, item) => sum + item.quantity * item.capacity_tb, 0);
  const planDiskCount = draft.items.filter((item) => item.category === "硬盘").reduce((sum, item) => sum + item.quantity, 0);

  const createPlan = () => {
    setSelectedBuildId(null);
    setDraft(emptyDraft());
    setView("editor");
  };

  const selectPlan = (build: Build) => {
    setSelectedBuildId(build.id);
    setDraft(toDraft(build));
    setView("editor");
  };

  const savePlan = async () => {
    if (!draft.name.trim()) {
      notify("请先填写方案名称");
      return;
    }
    try {
      const saved = selectedBuildId ? await api.updateBuild(selectedBuildId, draft) : await api.createBuild(draft);
      setSelectedBuildId(saved.id);
      setDraft(toDraft(saved));
      await loadBuilds();
      notify("方案已保存，价格已记录为当前快照");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };

  const deletePlan = async () => {
    if (!selectedBuildId) return;
    if (!window.confirm("确定删除这个保存的方案吗？")) return;
    try {
      await api.deleteBuild(selectedBuildId);
      setSelectedBuildId(null);
      setDraft(emptyDraft());
      await loadBuilds(true);
      notify("方案已删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除方案失败");
    }
  };

  const addCatalogItemToPlan = (item: CatalogItem) => {
    setDraft((current) => ({
      ...current,
      items: [
        ...current.items,
        {
          catalog_item_id: item.id,
          category: item.category,
          name: item.name,
          quantity: 1,
          unit_price: item.price,
          specs: item.specs,
          capacity_tb: item.capacity_tb,
          power_w: item.power_w,
          notes: item.notes,
        },
      ],
    }));
    notify(`${item.name} 已加入方案`);
  };

  const updatePlanItem = (index: number, patch: Partial<BuildItem>) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    }));
  };

  const removePlanItem = (index: number) => {
    setDraft((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }));
  };

  const resetCatalogForm = () => {
    setEditingCatalogId(null);
    setCpuHint(null);
    setAutoCpuSpecs("");
    setAutoCpuPower(0);
    setCpuSuggestions([]);
    setGpuSuggestions([]);
    const category = catalogCategory === "全部" ? categories[0] ?? "CPU" : catalogCategory;
    prevCategoryRef.current = category;
    setCatalogForm({ category, name: "", price: 0, specs: "", capacity_tb: 0, power_w: 0, notes: "" });
  };

  const handleCatalogFormChange = (next: Omit<CatalogItem, "id" | "updated_at">) => {
    if (next.category !== "显卡") {
      setGpuSuggestions([]);
      setGpuLookupLoading(false);
    }
    let base = next;
    if (prevCategoryRef.current !== next.category) {
      // 换分类等于换了一种配件：容量、功耗和自动填充状态都从头来。
      // 否则上一个分类残留的功耗会让本地识别的 TDP 永远填不进去。
      prevCategoryRef.current = next.category;
      base = { ...next, capacity_tb: 0, power_w: 0 };
      setAutoCpuSpecs("");
      setAutoCpuPower(0);
    }
    const hint = base.category === "CPU" ? findCpuHint(base.name) : null;
    let updated = {
      ...base,
      capacity_tb: isStorageCategory(base.category) ? base.capacity_tb : 0,
      power_w: hasPowerField(base.category) ? base.power_w : 0,
    };
    const specs = updated.specs.trim();
    if (hint && (!specs || specs === autoCpuSpecs)) {
      updated = { ...updated, specs: cpuHintSpecs(hint) };
      setAutoCpuSpecs(updated.specs);
    } else if (!hint || (autoCpuSpecs && specs !== autoCpuSpecs)) {
      setAutoCpuSpecs("");
    }
    const powerWasAutoFilled = autoCpuPower !== 0 && updated.power_w === autoCpuPower;
    if (hint && (updated.power_w === 0 || powerWasAutoFilled)) {
      updated = { ...updated, power_w: hint.tdp_w };
      setAutoCpuPower(hint.tdp_w);
    } else if (!hint || (autoCpuPower !== 0 && updated.power_w !== autoCpuPower)) {
      setAutoCpuPower(0);
    }
    setCpuHint(hint);
    setCatalogForm(updated);
  };

  const saveCatalogItem = async () => {
    if (!catalogForm.name.trim()) {
      notify("请填写配件名称/型号");
      return;
    }
    const payload = {
      ...catalogForm,
      capacity_tb: isStorageCategory(catalogForm.category) ? catalogForm.capacity_tb : 0,
      power_w: hasPowerField(catalogForm.category) ? catalogForm.power_w : 0,
    };
    try {
      if (editingCatalogId) await api.updateCatalog(editingCatalogId, payload);
      else await api.createCatalog(payload);
      await loadCatalog();
      resetCatalogForm();
      notify(editingCatalogId ? "报价已更新" : "配件已加入报价库");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };

  const editCatalogItem = (item: CatalogItem) => {
    setEditingCatalogId(item.id);
    prevCategoryRef.current = item.category;
    setCatalogForm({ category: item.category, name: item.name, price: item.price, specs: item.specs, capacity_tb: isStorageCategory(item.category) ? item.capacity_tb : 0, power_w: hasPowerField(item.category) ? item.power_w : 0, notes: item.notes });
    const hint = item.category === "CPU" ? findCpuHint(item.name) : null;
    setCpuHint(hint);
    setAutoCpuSpecs(hint && item.specs === cpuHintSpecs(hint) ? item.specs : "");
    setAutoCpuPower(hint && item.power_w === hint.tdp_w ? item.power_w : 0);
    if (item.category !== "显卡") setGpuSuggestions([]);
  };

  const applyCpuSuggestion = (suggestion: CpuSuggestion) => {
    // 采纳建议会改写 name，标记一次跳过查找，否则 450ms 后列表又自己弹回来。
    skipCpuLookupRef.current = true;
    setAutoCpuSpecs(suggestion.specs);
    setAutoCpuPower(suggestion.tdp_w || 0);
    setCpuHint(null);
    setCpuSuggestions([]);
    setCatalogForm((current) => ({
      ...current,
      name: suggestion.model || suggestion.name,
      specs: suggestion.specs,
      power_w: suggestion.tdp_w ?? current.power_w,
    }));
    notify(`已加载 ${suggestion.model || suggestion.name} 的在线规格`);
  };

  const applyGpuSuggestion = (suggestion: GpuSuggestion) => {
    skipGpuLookupRef.current = true;
    setGpuSuggestions([]);
    setCatalogForm((current) => ({
      ...current,
      name: suggestion.name,
      specs: suggestion.specs,
      power_w: suggestion.tdp_w ?? current.power_w,
    }));
    notify(`已加载 ${suggestion.name} 的在线规格`);
  };

  const refreshCpuDataset = async () => {
    try {
      const result = await api.refreshCpu();
      notify(`CPU 数据已更新，共 ${result.count} 条`);
      if (catalogForm.name.trim().length >= 3) {
        setCpuSuggestions(await api.cpuLookup(catalogForm.name.trim()));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "CPU 数据更新失败");
    }
  };

  const refreshGpuDataset = async () => {
    try {
      const result = await api.refreshGpu();
      notify(`GPU 数据已更新，共 ${result.count} 条`);
      if (catalogForm.category === "显卡" && catalogForm.name.trim().length >= 2) {
        setGpuSuggestions(await api.gpuLookup(catalogForm.name.trim()));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "GPU 数据更新失败");
    }
  };

  const deleteCatalogItem = async (item: CatalogItem) => {
    if (!window.confirm(`删除“${item.name}”吗？已保存方案里的历史价格不会受影响。`)) return;
    try {
      await api.deleteCatalog(item.id);
      await loadCatalog();
      notify("配件已删除");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };

  const toggleSelectCatalogItem = (id: number) => {
    setSelectedCatalogIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  };

  const toggleSelectAllCatalogItems = (ids: number[]) => {
    const allSelected = ids.length > 0 && ids.every(id => selectedCatalogIds.includes(id));
    if (allSelected) {
      setSelectedCatalogIds(prev => prev.filter(id => !ids.includes(id)));
    } else {
      const newIds = new Set([...selectedCatalogIds, ...ids]);
      setSelectedCatalogIds(Array.from(newIds));
    }
  };

  const batchDeleteCatalogItems = async () => {
    if (selectedCatalogIds.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${selectedCatalogIds.length} 个配件吗？已保存方案里的历史价格不会受影响。`)) return;
    const ids = [...selectedCatalogIds];
    const results = await Promise.allSettled(ids.map((id) => api.deleteCatalog(id)));
    const failedIds = ids.filter((_, index) => results[index].status === "rejected");
    setSelectedCatalogIds(failedIds);
    try {
      await loadCatalog();
    } catch {
      // 列表刷新失败时保留当前数据，至少提示已经发生的结果
    }
    const deleted = ids.length - failedIds.length;
    notify(failedIds.length === 0 ? `已删除 ${deleted} 个配件` : `已删除 ${deleted} 个，${failedIds.length} 个失败`);
  };

  const toggleCompare = (id: number) => {
    setCompareSelection((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length >= 4 ? current : [...current, id]);
  };

  const navItems = [
    { id: "saved" as View, label: "已保存方案", icon: Archive, count: builds.length },
    { id: "editor" as View, label: "配置工作台", icon: Pencil },
    { id: "catalog" as View, label: "报价库", icon: Package, count: catalog.length },
    { id: "compare" as View, label: "方案对比", icon: GitCompareArrows, count: compareSelection.length || undefined },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><Settings2 size={20} /></div>
          <div><strong>BuildDesk</strong><span>整机 / NAS 方案台</span></div>
        </div>
        <div className="local-status"><span className={`status-dot ${status}`} />{status === "ready" ? "本地数据库已连接" : status === "loading" ? "正在连接" : "后端未启动"}</div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => setView(item.id)}><Icon size={18} /><span>{item.label}</span>{item.count !== undefined && <em>{item.count}</em>}</button>;
          })}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-rule" /><div className="storage-note"><Database size={16} /><span><b>本地优先</b>数据保存在项目的 SQLite 中</span></div></div>
      </aside>

      <main className="main-content">
        {view === "saved" && <SavedView builds={builds} onCreate={createPlan} onSelect={selectPlan} onExport={downloadExport} />}
        {view === "editor" && <EditorView draft={draft} selectedBuildId={selectedBuildId} planTotal={planTotal} planPower={planPower} planCapacity={planCapacity} planDiskCount={planDiskCount} catalog={catalog} onCreate={createPlan} onDraftChange={setDraft} onSave={savePlan} onDelete={deletePlan} onAddItem={addCatalogItemToPlan} onUpdateItem={updatePlanItem} onRemoveItem={removePlanItem} />}
        {view === "catalog" && <CatalogView categories={categories} catalog={catalog} selectedCategory={catalogCategory} search={catalogSearch} filteredItems={filteredCatalog} form={catalogForm} editingId={editingCatalogId} cpuHint={cpuHint} cpuSuggestions={cpuSuggestions} cpuLookupLoading={cpuLookupLoading} gpuSuggestions={gpuSuggestions} gpuLookupLoading={gpuLookupLoading} selectedIds={selectedCatalogIds} onToggleSelect={toggleSelectCatalogItem} onToggleSelectAll={toggleSelectAllCatalogItems} onBatchDelete={batchDeleteCatalogItems} onCategoryChange={setCatalogCategory} onSearchChange={setCatalogSearch} onFormChange={handleCatalogFormChange} onEdit={editCatalogItem} onDelete={deleteCatalogItem} onSave={saveCatalogItem} onReset={resetCatalogForm} onApplyCpuSuggestion={applyCpuSuggestion} onRefreshCpu={refreshCpuDataset} onApplyGpuSuggestion={applyGpuSuggestion} onRefreshGpu={refreshGpuDataset} onExport={downloadExport} />}
        {view === "compare" && <CompareView builds={builds} selectedIds={compareSelection} compareBuilds={compareBuilds} onToggle={toggleCompare} onClear={() => setCompareSelection([])} />}
      </main>
      {toast && <div className="toast"><Check size={16} />{toast}</div>}
    </div>
  );
}

function SavedView({ builds, onCreate, onSelect, onExport }: { builds: Build[]; onCreate: () => void; onSelect: (b: Build) => void; onExport: () => void }) {
  return <>
    <header className="page-header"><div><div className="eyebrow">SAVED BUILDS</div><h1>已保存方案</h1><p>查看并管理你保存的所有机器配置。</p></div><div className="header-actions"><button className="button secondary" onClick={onExport}><Download size={17} />导出备份</button><button className="button primary" onClick={onCreate}><FilePlus2 size={17} />新建方案</button></div></header>
    {builds.length === 0 ? <div className="empty-state"><Archive size={38} /><p>还没有保存任何方案</p><button className="button secondary" style={{marginTop: 12}} onClick={onCreate}>开始配置新装机</button></div> : 
      <div className="saved-grid">
         {builds.map((build) => (
           <button key={build.id} className="panel saved-card" onClick={() => onSelect(build)}>
             <span className="plan-avatar">{build.name.slice(0, 1)}</span>
             <div className="saved-card-content">
               <b>{build.name}</b>
               <small>{build.kind} · {build.items.length} 项配件</small>
               <strong>¥{money(build.total)}</strong>
             </div>
           </button>
         ))}
      </div>
    }
  </>;
}

type EditorProps = {
  draft: BuildDraft; selectedBuildId: number | null; planTotal: number; planPower: number; planCapacity: number; planDiskCount: number; catalog: CatalogItem[];
  onCreate: () => void; onDraftChange: (draft: BuildDraft) => void; onSave: () => void; onDelete: () => void; onAddItem: (item: CatalogItem) => void; onUpdateItem: (index: number, patch: Partial<BuildItem>) => void; onRemoveItem: (index: number) => void;
};

function EditorView({ draft, selectedBuildId, planTotal, planPower, planCapacity, planDiskCount, catalog, onCreate, onDraftChange, onSave, onDelete, onAddItem, onUpdateItem, onRemoveItem }: EditorProps) {
  const [search, setSearch] = useState("");
  const suggestions = catalog.filter((item) => `${item.name} ${item.category} ${item.specs}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6);
  return <>
    <header className="page-header"><div><div className="eyebrow">CONFIGURATION WORKBENCH</div><h1>配置工作台</h1><p>新建或编辑你的装机方案。</p></div><div className="header-actions"><button className="button secondary" onClick={onCreate}><FilePlus2 size={17} />新建方案</button></div></header>
    <div className="workbench-grid editor-only">
      <section className="editor-main">
        <div className="panel build-editor"><div className="editor-title-row"><div><span className="panel-kicker">{selectedBuildId ? "EDITING SAVED BUILD" : "NEW BUILD"}</span><input className="build-name-input" value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} /></div><button className="icon-button danger" title="删除方案" onClick={onDelete} disabled={!selectedBuildId}><Trash2 size={17} /></button></div><div className="build-meta-row"><label>方案类型<select value={draft.kind} onChange={(event) => onDraftChange({ ...draft, kind: event.target.value })}>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label className="notes-field">备注<input value={draft.notes} placeholder="例如：准备做照片备份 + Docker" onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })} /></label></div></div>
        <div className="panel add-components"><div className="section-title"><div><span className="panel-kicker">ADD COMPONENT</span><h2>加入配件</h2></div><span className="muted">报价库中的当前价格会被保存为方案快照</span></div><div className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索型号、分类或规格，例如 N100 / 14TB / RTX 4060" /></div>{search && <div className="suggestions">{suggestions.length === 0 ? <span className="muted">没有匹配的配件，可去报价库新增</span> : suggestions.map((item) => <button key={item.id} className="suggestion-item" onClick={() => { onAddItem(item); setSearch(""); }}><span className="category-tag">{item.category}</span><b>{item.name}</b><span className="suggestion-spec">{item.specs}</span><strong>¥{money(item.price)}</strong><Plus size={15} /></button>)}</div>}</div>
        <div className="panel items-panel"><div className="section-title"><div><span className="panel-kicker">COMPONENTS</span><h2>方案明细 <span>{draft.items.length}</span></h2></div><span className="muted">保存后仍保留当时的价格</span></div>{draft.items.length === 0 ? <div className="empty-state"><Package size={30} /><p>还没有配件</p><span>用上方搜索框把配件加入方案</span></div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>分类</th><th>硬件名称 / 型号</th><th>数量</th><th>单价</th><th>小计</th><th>规格</th><th></th></tr></thead><tbody>{draft.items.map((item, index) => <tr key={`${item.catalog_item_id ?? item.name}-${index}`}><td><span className="category-tag">{item.category}</span></td><td><b>{item.name}</b>{item.notes && <small className="cell-note">{item.notes}</small>}</td><td><input className="qty-input" type="number" min="1" value={item.quantity} onChange={(event) => onUpdateItem(index, { quantity: Math.max(1, Number(event.target.value) || 1) })} /></td><td>¥{money(item.unit_price)}</td><td><b>¥{money(item.unit_price * item.quantity)}</b></td><td className="spec-cell">{item.specs || "-"}{item.capacity_tb > 0 && ` · ${decimal(item.capacity_tb)} TB`}</td><td><button className="icon-button subtle" title="移除配件" onClick={() => onRemoveItem(index)}><X size={16} /></button></td></tr>)}</tbody></table></div>}</div>
      </section>
      <aside className="editor-sidebar">
        <div className="panel metrics-panel">
          <div className="section-title" style={{ padding: 0 }}>
            <div><span className="panel-kicker">SUMMARY</span><h2>配置汇总</h2></div>
          </div>
          <div className="metric-strip vertical">
            <Metric label="当前总价" value={`¥${money(planTotal)}`} accent="amber" />
            <Metric label="预估功耗" value={`${decimal(planPower)} W`} />
            <Metric label="硬盘数量" value={`${planDiskCount} 块`} />
            <Metric label="总容量" value={`${decimal(planCapacity)} TB`} />
          </div>
          <button className="button primary full-width" onClick={onSave}><Save size={16} />保存当前方案</button>
        </div>
      </aside>
    </div>
  </>;
}

function Metric({ label, value, accent = "" }: { label: string; value: string; accent?: string }) {
  return <div className={`metric ${accent}`}><span>{label}</span><b>{value}</b></div>;
}

type CatalogProps = {
  categories: string[]; catalog: CatalogItem[]; selectedCategory: string; search: string; filteredItems: CatalogItem[]; form: Omit<CatalogItem, "id" | "updated_at">; editingId: number | null; cpuHint: CpuHint | null; cpuSuggestions: CpuSuggestion[]; cpuLookupLoading: boolean; gpuSuggestions: GpuSuggestion[]; gpuLookupLoading: boolean;
  selectedIds: number[]; onToggleSelect: (id: number) => void; onToggleSelectAll: (ids: number[]) => void; onBatchDelete: () => void;
  onCategoryChange: (category: string) => void; onSearchChange: (search: string) => void; onFormChange: (form: Omit<CatalogItem, "id" | "updated_at">) => void; onEdit: (item: CatalogItem) => void; onDelete: (item: CatalogItem) => void; onSave: () => void; onReset: () => void; onApplyCpuSuggestion: (suggestion: CpuSuggestion) => void; onRefreshCpu: () => void; onApplyGpuSuggestion: (suggestion: GpuSuggestion) => void; onRefreshGpu: () => void; onExport: () => void;
};

function CatalogView({ categories, catalog, selectedCategory, search, filteredItems, form, editingId, cpuHint, cpuSuggestions, cpuLookupLoading, gpuSuggestions, gpuLookupLoading, selectedIds, onToggleSelect, onToggleSelectAll, onBatchDelete, onCategoryChange, onSearchChange, onFormChange, onEdit, onDelete, onSave, onReset, onApplyCpuSuggestion, onRefreshCpu, onApplyGpuSuggestion, onRefreshGpu, onExport }: CatalogProps) {
  const allFilteredIds = filteredItems.map((item) => item.id);
  const isAllSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.includes(id));
  const showCapacityColumn = selectedCategory === "全部" || isStorageCategory(selectedCategory);
  const showPowerColumn = selectedCategory === "全部" || hasPowerField(selectedCategory);

  return <>
    <header className="page-header">
      <div>
        <div className="eyebrow">PARTS & PRICES</div>
        <h1>报价库</h1>
        <p>按配件类型分别维护报价；保存方案时会记录当时的价格。</p>
      </div>
      <div className="header-actions">
        <button className="button secondary" onClick={onExport}><Download size={16} />导出备份</button>
        <button className="button secondary" onClick={onRefreshCpu}><RefreshCw size={16} />更新 CPU 数据</button>
        <button className="button secondary" onClick={onRefreshGpu}><RefreshCw size={16} />更新 GPU 数据</button>
        {selectedIds.length > 0 && <button className="button secondary danger" onClick={onBatchDelete} style={{ color: "var(--danger)", borderColor: "var(--danger)" }}><Trash2 size={17} />批量删除 ({selectedIds.length})</button>}
      </div>
    </header>

    <div className="catalog-layout">
      <section className="panel catalog-panel">
        <div className="category-tabs">
          <button className={selectedCategory === "全部" ? "active" : ""} onClick={() => onCategoryChange("全部")}>全部 <span>{catalog.length}</span></button>
          {categories.map((category) => <button key={category} className={selectedCategory === category ? "active" : ""} onClick={() => onCategoryChange(category)}>{category} <span>{catalog.filter((item) => item.category === category).length}</span></button>)}
        </div>
        <div className="catalog-toolbar">
          <div className="search-field"><Search size={17} /><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索型号、规格或备注" /></div>
          <span className="muted">{filteredItems.length} 个配件</span>
        </div>
        <div className="table-wrap">
          <table className="data-table catalog-table">
            <thead><tr><th style={{ width: 40 }}><input type="checkbox" checked={isAllSelected} onChange={() => onToggleSelectAll(allFilteredIds)} /></th><th>分类</th><th>硬件名称 / 型号</th><th>参考报价</th><th>规格</th>{showCapacityColumn && <th>容量</th>}{showPowerColumn && <th>功耗</th>}<th>备注</th><th></th></tr></thead>
            <tbody>{filteredItems.map((item) => <tr key={item.id}>
              <td><input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => onToggleSelect(item.id)} /></td>
              <td><span className="category-tag">{item.category}</span></td>
              <td><b>{item.name}</b></td>
              <td className="price-cell">¥{money(item.price)}</td>
              <td>{item.specs || "-"}</td>
              {showCapacityColumn && <td>{item.capacity_tb ? `${decimal(item.capacity_tb)} TB` : "-"}</td>}
              {showPowerColumn && <td>{item.power_w ? `${decimal(item.power_w)} W` : "-"}</td>}
              <td className="spec-cell">{item.notes || "-"}</td>
              <td className="row-actions"><button className="icon-button subtle" title="编辑" onClick={() => onEdit(item)}><Pencil size={15} /></button><button className="icon-button subtle danger" title="删除" onClick={() => onDelete(item)}><Trash2 size={15} /></button></td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <aside className="panel catalog-form" onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); onSave(); } }}>
        <div className="section-title"><div><span className="panel-kicker">{editingId ? "EDIT PART" : "NEW PART"}</span><h2>{editingId ? "编辑配件" : "新增配件"}</h2></div>{editingId && <button className="icon-button subtle" title="取消编辑" onClick={onReset}><X size={16} /></button>}</div>
        <CatalogField label="分类"><select value={form.category} onChange={(event) => onFormChange({ ...form, category: event.target.value })}>{categories.map((category) => <option key={category}>{category}</option>)}</select></CatalogField>
        <CatalogField label="硬件名称 / 型号">
          <input value={form.name} placeholder="例如：RTX 4060 8GB" onChange={(event) => onFormChange({ ...form, name: event.target.value })} />
          {form.category === "CPU" && cpuLookupLoading && <span className="cpu-hint muted"><RefreshCw size={14} />正在查询在线 CPU 规格…</span>}
          {form.category === "CPU" && cpuHint && <span className="cpu-hint"><Sparkles size={14} />本地识别：{cpuHintSpecs(cpuHint)} · 参考功耗 {cpuHint.tdp_w} W，已自动填入</span>}
          {form.category === "CPU" && form.name.trim().length >= 4 && !cpuHint && !cpuLookupLoading && cpuSuggestions.length === 0 && <span className="cpu-hint muted"><Sparkles size={14} />未在本地匹配到，正在等待在线结果或可手动填写</span>}
          {form.category === "CPU" && cpuSuggestions.length > 0 && <div className="cpu-suggestions"><span className="cpu-suggestions-title">在线匹配结果</span>{cpuSuggestions.slice(0, 5).map((suggestion) => <button type="button" key={`${suggestion.vendor}-${suggestion.model}`} className="cpu-suggestion" onClick={() => onApplyCpuSuggestion(suggestion)}><span><b>{suggestion.model || suggestion.name}</b><small>{suggestion.vendor} · {suggestion.specs}{suggestion.tdp_w ? ` · ${suggestion.tdp_w} W` : ""}</small></span><ArrowRight size={15} /></button>)}<small className="cpu-source">数据源：在线 CPU 规格数据，结果会在后端缓存</small></div>}
          {form.category === "显卡" && gpuLookupLoading && <span className="cpu-hint muted"><RefreshCw size={14} />正在查询在线 GPU 规格…</span>}
          {form.category === "显卡" && !gpuLookupLoading && gpuSuggestions.length === 0 && form.name.trim().length >= 2 && <span className="cpu-hint muted"><Sparkles size={14} />输入显卡型号后会显示在线匹配结果</span>}
          {form.category === "显卡" && gpuSuggestions.length > 0 && <div className="cpu-suggestions"><span className="cpu-suggestions-title">在线匹配结果</span>{gpuSuggestions.slice(0, 5).map((suggestion) => <button type="button" key={`${suggestion.vendor}-${suggestion.name}`} className="cpu-suggestion" onClick={() => onApplyGpuSuggestion(suggestion)}><span><b>{suggestion.name}</b><small>{suggestion.vendor} · {suggestion.specs}{suggestion.tdp_w ? ` · ${suggestion.tdp_w} W` : ""}</small></span><ArrowRight size={15} /></button>)}<small className="cpu-source">数据源：在线 GPU 规格数据，点击后带入右侧表单</small></div>}
        </CatalogField>
        <CatalogNumericFields key={`${editingId ?? "new"}-${form.category}`} category={form.category} form={form} onFormChange={onFormChange} />
        <CatalogField label="规格说明"><input value={form.specs} placeholder={specsPlaceholder(form.category)} onChange={(event) => onFormChange({ ...form, specs: event.target.value })} /></CatalogField>
        <CatalogField label="备注"><textarea rows={3} value={form.notes} placeholder="兼容性、健康度、购买注意事项" onChange={(event) => onFormChange({ ...form, notes: event.target.value })} /></CatalogField>
        <button className="button primary full-width" onClick={onSave}><Save size={16} />{editingId ? "保存修改" : "加入报价库"}</button>
      </aside>
    </div>
  </>;
}


function CatalogNumericFields({ category, form, onFormChange }: { category: string; form: Omit<CatalogItem, "id" | "updated_at">; onFormChange: (form: Omit<CatalogItem, "id" | "updated_at">) => void }) {
  const [priceText, setPriceText] = useState(form.price === 0 ? "" : String(form.price));
  const [capacityText, setCapacityText] = useState(form.capacity_tb === 0 ? "" : String(form.capacity_tb));
  const [powerText, setPowerText] = useState(form.power_w === 0 ? "" : String(form.power_w));

  useEffect(() => {
    if ((parseFloat(priceText) || 0) !== form.price) setPriceText(form.price === 0 ? "" : String(form.price));
  }, [form.price, priceText]);

  useEffect(() => {
    if ((parseFloat(capacityText) || 0) !== form.capacity_tb) setCapacityText(form.capacity_tb === 0 ? "" : String(form.capacity_tb));
  }, [form.capacity_tb, capacityText]);

  useEffect(() => {
    if ((parseFloat(powerText) || 0) !== form.power_w) setPowerText(form.power_w === 0 ? "" : String(form.power_w));
  }, [form.power_w, powerText]);

  return <div className={`form-grid ${!isStorageCategory(category) || !hasPowerField(category) ? "form-grid-compact" : ""}`}>
    <CatalogField label="参考报价"><input inputMode="decimal" placeholder="0" value={priceText} onChange={(e) => { setPriceText(e.target.value); onFormChange({ ...form, price: parseFloat(e.target.value) || 0 }); }} /></CatalogField>
    {isStorageCategory(category) && <CatalogField label="容量 TB"><input inputMode="decimal" placeholder="例如：14" value={capacityText} onChange={(e) => { setCapacityText(e.target.value); onFormChange({ ...form, capacity_tb: parseFloat(e.target.value) || 0 }); }} /></CatalogField>}
    {hasPowerField(category) && <CatalogField label="参考功耗 W"><input inputMode="decimal" placeholder="例如：65" value={powerText} onChange={(e) => { setPowerText(e.target.value); onFormChange({ ...form, power_w: parseFloat(e.target.value) || 0 }); }} /></CatalogField>}
  </div>;
}

function CatalogField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="catalog-field"><span>{label}</span>{children}</label>;
}

function CompareView({ builds, selectedIds, compareBuilds, onToggle, onClear }: { builds: Build[]; selectedIds: number[]; compareBuilds: Build[]; onToggle: (id: number) => void; onClear: () => void }) {
  const lineItems = useMemo(() => {
    const keys = new Map<string, { category: string; name: string }>();
    compareBuilds.forEach((build) => build.items.forEach((item) => keys.set(`${item.category}:${item.name}`, { category: item.category, name: item.name })));
    return [...keys.entries()].map(([key, value]) => ({ key, ...value }));
  }, [compareBuilds]);
  return <>
    <header className="page-header"><div><div className="eyebrow">SIDE-BY-SIDE REVIEW</div><h1>方案对比</h1><p>选择最多 4 个已保存方案，按总价、功耗和具体配件逐项查看差异。</p></div><div className="header-actions">{selectedIds.length > 0 && <button className="button secondary" onClick={onClear}><RefreshCw size={16} />清空选择</button>}</div></header>
    <section className="panel compare-picker"><div className="section-title"><div><span className="panel-kicker">SELECT SAVED BUILDS</span><h2>选择要比较的方案</h2></div><span className="muted">{selectedIds.length} / 4 已选择</span></div>{builds.length === 0 ? <div className="empty-state small"><Archive size={24} /><p>先保存至少一个方案</p></div> : <div className="compare-options">{builds.map((build) => <label key={build.id} className={`compare-option ${selectedIds.includes(build.id) ? "selected" : ""}`}><input type="checkbox" checked={selectedIds.includes(build.id)} onChange={() => onToggle(build.id)} /><span className="checkmark"><Check size={14} /></span><span><b>{build.name}</b><small>{build.kind} · ¥{money(build.total)}</small></span></label>)}</div>}</section>
    {compareBuilds.length > 0 ? <section className="panel comparison-table-panel"><div className="table-wrap"><table className="data-table comparison-table"><thead><tr><th>指标</th>{compareBuilds.map((build) => <th key={build.id}>{build.name}<small>{build.kind}</small></th>)}</tr></thead><tbody><tr className="metric-row"><td>总价</td>{compareBuilds.map((build) => <td key={build.id}>¥{money(build.total)}</td>)}</tr><tr><td>预估功耗</td>{compareBuilds.map((build) => <td key={build.id}>{decimal(build.total_power_w)} W</td>)}</tr><tr><td>硬盘数量</td>{compareBuilds.map((build) => <td key={build.id}>{build.disk_count} 块</td>)}</tr><tr><td>总容量</td>{compareBuilds.map((build) => <td key={build.id}>{decimal(build.total_capacity_tb)} TB</td>)}</tr>{lineItems.map((line) => <tr key={line.key}><td><span className="category-tag">{line.category}</span><b>{line.name}</b></td>{compareBuilds.map((build) => { const item = build.items.find((candidate) => candidate.category === line.category && candidate.name === line.name); return <td key={build.id}>{item ? <><b>{item.quantity} × ¥{money(item.unit_price)}</b><small>{item.specs || ""}</small></> : <span className="not-included">未配置</span>}</td>; })}</tr>)}</tbody></table></div></section> : <div className="empty-state compare-empty"><GitCompareArrows size={38} /><h3>选择方案开始对比</h3><p>你可以同时比较低功耗 NAS、性能整机和二手方案。</p></div>}
  </>;
}

export default App;
