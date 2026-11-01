from __future__ import annotations

import csv
import io
import json
import re
import shutil
import sqlite3
import threading
import time
import urllib.request
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "hardware_helper.sqlite3"
BACKUP_DIR = DATA_DIR / "backups"
BACKUP_KEEP = 10
CPU_DATA_URLS = {
    "Intel": "https://raw.githubusercontent.com/felixsteinke/cpu-spec-dataset/main/dataset/intel-cpus.csv",
    "AMD": "https://raw.githubusercontent.com/felixsteinke/cpu-spec-dataset/main/dataset/amd-cpus.csv",
}
CPU_CACHE_TTL_SECONDS = 24 * 60 * 60
GPU_DATA_URL = "https://raw.githubusercontent.com/RightNow-AI/RightNow-GPU-Database/main/data/all-gpus.json"
GPU_CACHE_TTL_SECONDS = 24 * 60 * 60
HIDDEN_CATALOG_CATEGORIES = ("系统", "键鼠")
STORAGE_CATEGORIES = ("SSD", "硬盘")
POWER_CATEGORIES = ("CPU", "主板", "内存", "显卡", "SSD", "硬盘", "HBA卡", "网卡", "电源", "散热")
DATASET_RETRY_BACKOFF_SECONDS = 60


class _DatasetCache:
    """在线规格数据的进程内缓存：TTL + 失败退避 + 线程安全。

    原实现在下载失败时既不记录缓存、也不记录失败时间，于是离线状态下
    每次输入都会重新打一遍网络（CPU 两个地址各 12 秒），输入框直接卡住。
    现在失败也记录时间戳，退避窗口内直接返回当前缓存。
    """

    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._rows: list[dict] = []
        self._loaded_at = 0.0
        self._error_at = 0.0
        self._lock = threading.Lock()

    @property
    def loaded_at(self) -> float:
        return self._loaded_at

    def _is_fresh(self) -> bool:
        return bool(self._rows) and time.time() - self._loaded_at < self._ttl

    def _is_backing_off(self) -> bool:
        return time.time() - self._error_at < DATASET_RETRY_BACKOFF_SECONDS

    def load(self, fetch: Callable[[], Optional[list[dict]]], force: bool = False) -> tuple[list[dict], bool]:
        """返回 ``(rows, 本次是否真的取到新数据)``。"""
        if not force and (self._is_fresh() or self._is_backing_off()):
            return self._rows, False
        with self._lock:
            if not force and (self._is_fresh() or self._is_backing_off()):
                return self._rows, False
            rows = fetch()
            if rows:
                self._rows = rows
                self._loaded_at = time.time()
                self._error_at = 0.0
                return self._rows, True
            self._error_at = time.time()
            return self._rows, False


_cpu_dataset = _DatasetCache(CPU_CACHE_TTL_SECONDS)
_gpu_dataset = _DatasetCache(GPU_CACHE_TTL_SECONDS)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def escape_like(value: str) -> str:
    """转义 LIKE 通配符，避免搜索 `%` 或 `_` 时把整库都匹配出来。"""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def clean_required_text(value: str) -> str:
    """去掉首尾空白并拒绝纯空白——``min_length=1`` 挡不住 ``"   "``。"""
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("不能为空")
    return cleaned


def normalize_cpu_query(value: str) -> str:
    aliases = {
        "赛扬": "celeron",
        "奔腾": "pentium",
        "至强": "xeon",
        "酷睿": "core",
        "锐龙": "ryzen",
        "速龙": "athlon",
        "霄龙": "epyc",
    }
    for source, target in aliases.items():
        value = value.replace(source, target)
    value = re.sub(r"\b(?:intel|amd|processor|cpu)\b", "", value, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def parse_int(value: object) -> Optional[int]:
    match = re.search(r"\d+", str(value or ""))
    return int(match.group()) if match else None


def parse_float(value: object) -> Optional[float]:
    match = re.search(r"\d+(?:\.\d+)?", str(value or ""))
    return float(match.group()) if match else None


def clean_cpu_text(value: object) -> str:
    return re.sub(r"[®™]", "", str(value or "")).strip()


def format_cpu_specs(cores: Optional[int], threads: Optional[int], igpu: str) -> str:
    parts = []
    if cores is not None:
        parts.append(f"{cores}核")
    if threads is not None:
        parts.append(f"{threads}线程")
    if igpu == "未标注":
        parts.append("核显未标注")
    elif igpu:
        parts.append(f"{igpu} 核显")
    return " / ".join(parts) if parts else "在线数据未提供核心线程信息"


def normalize_cpu_row(vendor: str, row: dict) -> Optional[dict]:
    if vendor == "Intel":
        name = clean_cpu_text(row.get("CpuName"))
        model = clean_cpu_text(row.get("ProcessorNumber")) or name
        cores = parse_int(row.get("CoreCount"))
        threads = parse_int(row.get("ThreadCount"))
        igpu = clean_cpu_text(row.get("ProcessorGraphicsModelId"))
        tdp_w = parse_float(row.get("MaxTDP") or row.get("ProcessorBasePower"))
        source_url = clean_cpu_text(row.get("SourceUrl"))
    else:
        name = clean_cpu_text(row.get("Model"))
        model = name
        cores = parse_int(row.get("# of CPU Cores"))
        threads = parse_int(row.get("# of Threads"))
        igpu = clean_cpu_text(row.get("Graphics Model"))
        tdp_w = parse_float(row.get("Default TDP"))
        source_url = "https://www.amd.com/en/products/specifications/processors"
    if not name or cores is None or threads is None:
        return None
    return {
        "name": name,
        "model": model,
        "vendor": vendor,
        "cores": cores,
        "threads": threads,
        "igpu": igpu or "未标注",
        "tdp_w": tdp_w,
        "specs": format_cpu_specs(cores, threads, igpu or "未标注"),
        "source": f"{vendor} CPU 规格数据",
        "source_url": source_url,
    }


def normalize_gpu_query(value: str) -> str:
    aliases = {
        "英伟达": "nvidia",
        "英特尔": "intel",
        "阿姆达": "amd",
        "显卡": "",
        "图形卡": "",
        "graphics": "",
        "gpu": "",
    }
    for source, target in aliases.items():
        value = value.replace(source, target)
    value = re.sub(r"\b(?:nvidia|amd|intel)\b", "", value, flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def normalize_gpu_row(row: dict) -> Optional[dict]:
    name = clean_cpu_text(row.get("name"))
    if not name:
        return None
    memory_size = parse_float(row.get("memorySize"))
    memory_type = clean_cpu_text(row.get("memoryType"))
    memory_bus = parse_int(row.get("memoryBus"))
    tdp_w = parse_float(row.get("tdp"))
    architecture = clean_cpu_text(row.get("architecture"))
    generation = clean_cpu_text(row.get("generation"))
    bus_interface = clean_cpu_text(row.get("busInterface"))
    specs_parts = []
    if memory_size is not None:
        specs_parts.append(f"{memory_size:g}GB 显存")
    if memory_type:
        specs_parts.append(memory_type)
    if memory_bus is not None:
        specs_parts.append(f"{memory_bus}bit")
    if architecture:
        specs_parts.append(architecture)
    if bus_interface:
        specs_parts.append(bus_interface)
    return {
        "name": name,
        "vendor": clean_cpu_text(row.get("manufacturer") or row.get("vendor")).upper(),
        "gpu_name": clean_cpu_text(row.get("gpuName")),
        "architecture": architecture,
        "generation": generation,
        "memory_size_gb": memory_size,
        "memory_type": memory_type,
        "memory_bus": memory_bus,
        "tdp_w": tdp_w,
        "suggested_psu_w": parse_float(row.get("suggestedPSU")),
        "bus_interface": bus_interface,
        "specs": " · ".join(specs_parts) if specs_parts else "在线数据未提供详细规格",
        "source": "在线 GPU 规格数据",
        "source_url": clean_cpu_text(row.get("url")),
    }


def _fetch_gpu_rows() -> Optional[list[dict]]:
    try:
        request = urllib.request.Request(GPU_DATA_URL, headers={"User-Agent": "BuildDesk/0.1"})
        with urllib.request.urlopen(request, timeout=10) as response:
            raw_rows = json.loads(response.read().decode("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError):
        return None
    rows = [item for raw_row in raw_rows if (item := normalize_gpu_row(raw_row))]
    return rows or None


def load_gpu_dataset(force: bool = False) -> tuple[list[dict], bool]:
    return _gpu_dataset.load(_fetch_gpu_rows, force)


def gpu_match_score(query: str, item: dict) -> int:
    name = normalize_gpu_query(item["name"])
    gpu_name = normalize_gpu_query(item["gpu_name"])
    if query == name:
        return 100
    if query in name:
        return 95
    if query in gpu_name:
        return 85
    query_tokens = re.findall(r"[a-z]+|\d+", query)
    if query_tokens and all(token in name or token in gpu_name for token in query_tokens):
        return 70
    return 0


def _fetch_cpu_rows() -> Optional[list[dict]]:
    rows: list[dict] = []
    for vendor, url in CPU_DATA_URLS.items():
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "BuildDesk/0.1"})
            with urllib.request.urlopen(request, timeout=8) as response:
                content = response.read().decode("utf-8-sig")
        except (OSError, UnicodeError):
            continue
        try:
            for raw_row in csv.DictReader(io.StringIO(content)):
                item = normalize_cpu_row(vendor, raw_row)
                if item:
                    rows.append(item)
        except csv.Error:
            continue
    return rows or None


def load_cpu_dataset(force: bool = False) -> tuple[list[dict], bool]:
    return _cpu_dataset.load(_fetch_cpu_rows, force)


def cpu_match_score(query: str, item: dict) -> int:
    model = normalize_cpu_query(item["model"])
    name = normalize_cpu_query(item["name"])
    if query == model:
        return 100
    if query in model:
        return 95
    if query in name:
        return 85
    query_tokens = re.findall(r"[a-z]+|\d+", query)
    if query_tokens and all(token in model or token in name for token in query_tokens):
        return 70
    return 0


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """借用连接并在退出时关闭。

    ``sqlite3.Connection`` 的上下文管理器只提交/回滚事务，并不关闭连接，
    直接 ``with connect()`` 会让文件句柄一直等到 GC 才释放。
    """
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def backup_database() -> Optional[Path]:
    """启动前把数据库复制到 data/backups，只保留最近 BACKUP_KEEP 份。

    备份失败（权限、磁盘空间）不应阻断启动。
    """
    if not DB_PATH.exists() or DB_PATH.stat().st_size == 0:
        return None
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = BACKUP_DIR / f"hardware_helper-{stamp}.sqlite3"
        if not target.exists():
            shutil.copy2(DB_PATH, target)
        for stale in sorted(BACKUP_DIR.glob("hardware_helper-*.sqlite3"))[:-BACKUP_KEEP]:
            stale.unlink(missing_ok=True)
        return target
    except OSError:
        return None


def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS catalog_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                name TEXT NOT NULL,
                price REAL NOT NULL DEFAULT 0,
                specs TEXT NOT NULL DEFAULT '',
                capacity_tb REAL NOT NULL DEFAULT 0,
                power_w REAL NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS builds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT '通用整机',
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS build_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                build_id INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
                catalog_item_id INTEGER REFERENCES catalog_items(id) ON DELETE SET NULL,
                category TEXT NOT NULL,
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                unit_price REAL NOT NULL DEFAULT 0,
                specs TEXT NOT NULL DEFAULT '',
                capacity_tb REAL NOT NULL DEFAULT 0,
                power_w REAL NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT ''
            );
            """
        )
        category_names = [
            "CPU", "主板", "内存", "显卡", "SSD", "硬盘", "HBA卡", "网卡",
            "机箱", "电源", "散热", "风扇", "显示器", "其他",
        ]
        connection.executemany("DELETE FROM categories WHERE name = ?", [(name,) for name in HIDDEN_CATALOG_CATEGORIES])
        for index, name in enumerate(category_names):
            connection.execute(
                "INSERT OR IGNORE INTO categories(name, sort_order) VALUES (?, ?)",
                (name, index),
            )
        seeded = connection.execute("SELECT value FROM meta WHERE key = 'seeded'").fetchone()
        if seeded is None:
            existing = connection.execute("SELECT COUNT(*) AS count FROM catalog_items").fetchone()["count"]
            if existing == 0:
                seed_catalog(connection)
            connection.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('seeded', '1')")


def seed_catalog(connection: sqlite3.Connection) -> None:
    rows = [
        ("CPU", "Intel N100", 350, "4核4线程，低功耗", 0, 6, "入门 NAS、文件、照片"),
        ("CPU", "Intel i3-8100T", 280, "4核4线程", 0, 35, "低成本二手"),
        ("CPU", "AMD Ryzen 5 5600G", 450, "6核12线程", 0, 65, "整机、虚拟机"),
        ("主板", "华擎 N100DC-ITX", 650, "Mini-ITX，板载 CPU", 0, 10, "低功耗平台"),
        ("主板", "华硕 B550-I Gaming", 700, "Mini-ITX，AM4", 0, 15, "性能平台"),
        ("内存", "金士顿 DDR4 16GB", 180, "DDR4 16GB", 0, 5, ""),
        ("内存", "三星 DDR4 32GB", 330, "DDR4 32GB", 0, 7, ""),
        ("显卡", "NVIDIA RTX 4060 8GB", 2200, "8GB 显存", 0, 115, "游戏、创作、AI 入门"),
        ("SSD", "WD_BLACK SN770 1TB", 450, "NVMe PCIe 4.0", 1, 5, "系统与应用盘"),
        ("硬盘", "西数 HC530 14TB", 950, "企业级机械硬盘", 14, 8, "检查 SMART 与通电时间"),
        ("硬盘", "希捷 Exos X16 16TB", 1150, "企业级机械硬盘", 16, 9, "注意噪音与振动"),
        ("硬盘", "东芝 MG07 12TB", 780, "企业级机械硬盘", 12, 8, "二手可重点比较"),
        ("HBA卡", "LSI 9211-8i 刷 IT 模式", 260, "8 口 SAS/SATA 扩展", 0, 8, "扩展硬盘数量"),
        ("网卡", "Intel X540-T2", 420, "双口万兆电口", 0, 14, "需要万兆网络时使用"),
        ("机箱", "四盘位 NAS 机箱", 300, "支持 4 块 3.5 英寸硬盘", 0, 0, ""),
        ("机箱", "ATX 静音机箱", 360, "支持 ATX 主板与长显卡", 0, 0, "普通整机"),
        ("电源", "台达 300W 拆机电源", 120, "300W，拆机", 0, 20, "确认 SATA 供电数量"),
        ("电源", "海韵 500W 金牌", 480, "500W，金牌认证", 0, 18, "性能平台"),
        ("散热", "下压式 CPU 散热器", 60, "适合 Mini-ITX", 0, 3, ""),
        ("风扇", "120mm 静音风扇", 25, "机箱风扇", 0, 2, "按需增加"),
        ("显示器", "戴尔 24 英寸办公显示器", 650, "24 英寸，1080p", 0, 25, "可选配"),
    ]
    timestamp = now_iso()
    connection.executemany(
        """
        INSERT INTO catalog_items(category, name, price, specs, capacity_tb, power_w, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [(*row, timestamp) for row in rows],
    )


class _CatalogFields(BaseModel):
    category: str
    name: str = Field(min_length=1)
    price: float = Field(default=0, ge=0)
    specs: str = ""
    capacity_tb: float = Field(default=0, ge=0)
    power_w: float = Field(default=0, ge=0)
    notes: str = ""


class CatalogItemIn(_CatalogFields):
    @field_validator("category", "name")
    @classmethod
    def _strip_required_text(cls, value: str) -> str:
        return clean_required_text(value)


class CatalogItem(_CatalogFields):
    """响应模型：直接回显库里的值，不做输入侧的严格校验。"""

    id: int
    updated_at: str


class BuildItemIn(BaseModel):
    catalog_item_id: Optional[int] = None
    category: str
    name: str = Field(min_length=1)
    quantity: int = Field(default=1, ge=1)
    unit_price: float = Field(default=0, ge=0)
    specs: str = ""
    capacity_tb: float = Field(default=0, ge=0)
    power_w: float = Field(default=0, ge=0)
    notes: str = ""

    @field_validator("category", "name")
    @classmethod
    def _strip_required_text(cls, value: str) -> str:
        return clean_required_text(value)


class BuildIn(BaseModel):
    name: str = Field(min_length=1)
    kind: str = "通用整机"
    notes: str = ""
    items: list[BuildItemIn] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, value: str) -> str:
        return clean_required_text(value)

    @field_validator("kind")
    @classmethod
    def _default_kind(cls, value: str) -> str:
        return value.strip() or "通用整机"


def catalog_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


def ensure_category(connection: sqlite3.Connection, category: str) -> None:
    """拒绝不存在的分类，也拒绝被隐藏的分类（否则会写进看不见的行）。"""
    row = connection.execute("SELECT name FROM categories WHERE name = ?", (category,)).fetchone()
    if row is None or category in HIDDEN_CATALOG_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"未知分类：{category}")


def normalized_catalog_values(item: CatalogItemIn) -> dict:
    """容量只对存储类有意义、功耗只对有功耗的类别有意义，统一在服务端兜底。"""
    return {
        "category": item.category,
        "name": item.name,
        "price": item.price,
        "specs": item.specs,
        "capacity_tb": item.capacity_tb if item.category in STORAGE_CATEGORIES else 0.0,
        "power_w": item.power_w if item.category in POWER_CATEGORIES else 0.0,
        "notes": item.notes,
        "updated_at": now_iso(),
    }


def item_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["total"] = round(item["quantity"] * item["unit_price"], 2)
    item["total_power_w"] = round(item["quantity"] * item["power_w"], 2)
    item["total_capacity_tb"] = round(item["quantity"] * item["capacity_tb"], 2)
    return item


def build_to_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    build = dict(row)
    items = connection.execute(
        "SELECT * FROM build_items WHERE build_id = ? ORDER BY id", (build["id"],)
    ).fetchall()
    build["items"] = [item_to_dict(item) for item in items]
    build["total"] = round(sum(item["total"] for item in build["items"]), 2)
    build["total_power_w"] = round(sum(item["total_power_w"] for item in build["items"]), 2)
    build["total_capacity_tb"] = round(sum(item["total_capacity_tb"] for item in build["items"]), 2)
    build["disk_count"] = sum(item["quantity"] for item in build["items"] if item["category"] == "硬盘")
    return build


@asynccontextmanager
async def lifespan(_: FastAPI):
    backup_database()
    init_db()
    yield


app = FastAPI(title="Hardware Helper API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "database": str(DB_PATH)}


@app.get("/api/catalog/categories")
def categories() -> list[dict]:
    with db() as connection:
        rows = connection.execute("SELECT name FROM categories ORDER BY sort_order, name").fetchall()
    return [
        {
            "name": row["name"],
            "storage": row["name"] in STORAGE_CATEGORIES,
            "power": row["name"] in POWER_CATEGORIES,
        }
        for row in rows
    ]


@app.get("/api/catalog", response_model=list[CatalogItem])
def list_catalog(
    category: Optional[str] = None,
    q: Optional[str] = Query(default=None, max_length=100),
) -> list[CatalogItem]:
    query = "SELECT * FROM catalog_items WHERE category NOT IN (?, ?)"
    params: list[str] = list(HIDDEN_CATALOG_CATEGORIES)
    if category:
        query += " AND category = ?"
        params.append(category)
    if q:
        escaped = f"%{escape_like(q)}%"
        query += " AND (name LIKE ? ESCAPE '\\' OR specs LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')"
        params.extend([escaped, escaped, escaped])
    query += " ORDER BY category, name"
    with db() as connection:
        return [CatalogItem(**catalog_to_dict(row)) for row in connection.execute(query, params).fetchall()]


@app.post("/api/catalog", response_model=CatalogItem)
def create_catalog(item: CatalogItemIn) -> CatalogItem:
    with db() as connection:
        ensure_category(connection, item.category)
        cursor = connection.execute(
            """
            INSERT INTO catalog_items(category, name, price, specs, capacity_tb, power_w, notes, updated_at)
            VALUES (:category, :name, :price, :specs, :capacity_tb, :power_w, :notes, :updated_at)
            """,
            normalized_catalog_values(item),
        )
        row = connection.execute("SELECT * FROM catalog_items WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return CatalogItem(**catalog_to_dict(row))


@app.put("/api/catalog/{item_id}", response_model=CatalogItem)
def update_catalog(item_id: int, item: CatalogItemIn) -> CatalogItem:
    with db() as connection:
        ensure_category(connection, item.category)
        values = normalized_catalog_values(item)
        values["id"] = item_id
        cursor = connection.execute(
            """
            UPDATE catalog_items
            SET category=:category, name=:name, price=:price, specs=:specs,
                capacity_tb=:capacity_tb, power_w=:power_w, notes=:notes, updated_at=:updated_at
            WHERE id=:id
            """,
            values,
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="配件不存在")
        row = connection.execute("SELECT * FROM catalog_items WHERE id = ?", (item_id,)).fetchone()
        return CatalogItem(**catalog_to_dict(row))


@app.delete("/api/catalog/{item_id}")
def delete_catalog(item_id: int) -> dict:
    with db() as connection:
        cursor = connection.execute("DELETE FROM catalog_items WHERE id = ?", (item_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="配件不存在")
        return {"ok": True}


@app.get("/api/cpu/lookup")
def lookup_cpu(q: str = Query(..., min_length=3, max_length=100)) -> list[dict]:
    query = normalize_cpu_query(q)
    if len(query) < 3:
        return []
    rows, _ = load_cpu_dataset()
    matches = []
    for item in rows:
        score = cpu_match_score(query, item)
        if score:
            matches.append((score, len(item["model"]), item))
    matches.sort(key=lambda value: (-value[0], value[1], value[2]["name"]))
    return [item for _, _, item in matches[:8]]


@app.post("/api/cpu/refresh")
def refresh_cpu_dataset() -> dict:
    rows, fresh = load_cpu_dataset(force=True)
    if not rows:
        raise HTTPException(status_code=503, detail="在线 CPU 数据暂时不可用")
    if not fresh:
        raise HTTPException(
            status_code=503,
            detail=f"在线 CPU 数据源暂时不可用，仍使用上次缓存（{len(rows)} 条）",
        )
    return {
        "ok": True,
        "count": len(rows),
        "updated_at": datetime.fromtimestamp(_cpu_dataset.loaded_at, timezone.utc).isoformat(),
    }


@app.get("/api/gpu/lookup")
def lookup_gpu(q: str = Query(..., min_length=2, max_length=100)) -> list[dict]:
    query = normalize_gpu_query(q)
    if len(query) < 2:
        return []
    rows, _ = load_gpu_dataset()
    matches = []
    for item in rows:
        score = gpu_match_score(query, item)
        if score:
            matches.append((score, len(item["name"]), item))
    matches.sort(key=lambda value: (-value[0], value[1], value[2]["name"]))
    return [item for _, _, item in matches[:8]]


@app.post("/api/gpu/refresh")
def refresh_gpu_dataset() -> dict:
    rows, fresh = load_gpu_dataset(force=True)
    if not rows:
        raise HTTPException(status_code=503, detail="在线 GPU 数据暂时不可用")
    if not fresh:
        raise HTTPException(
            status_code=503,
            detail=f"在线 GPU 数据源暂时不可用，仍使用上次缓存（{len(rows)} 条）",
        )
    return {
        "ok": True,
        "count": len(rows),
        "updated_at": datetime.fromtimestamp(_gpu_dataset.loaded_at, timezone.utc).isoformat(),
    }


def save_build(payload: BuildIn, build_id: Optional[int] = None) -> dict:
    timestamp = now_iso()
    with db() as connection:
        if build_id is None:
            cursor = connection.execute(
                "INSERT INTO builds(name, kind, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                (payload.name, payload.kind, payload.notes, timestamp, timestamp),
            )
            build_id = cursor.lastrowid
        else:
            cursor = connection.execute(
                "UPDATE builds SET name=?, kind=?, notes=?, updated_at=? WHERE id=?",
                (payload.name, payload.kind, payload.notes, timestamp, build_id),
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="方案不存在")
            connection.execute("DELETE FROM build_items WHERE build_id = ?", (build_id,))
        connection.executemany(
            """
            INSERT INTO build_items(build_id, catalog_item_id, category, name, quantity, unit_price, specs, capacity_tb, power_w, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    build_id,
                    item.catalog_item_id,
                    item.category,
                    item.name,
                    item.quantity,
                    item.unit_price,
                    item.specs,
                    item.capacity_tb if item.category in STORAGE_CATEGORIES else 0,
                    item.power_w if item.category in POWER_CATEGORIES else 0,
                    item.notes,
                )
                for item in payload.items
            ],
        )
        row = connection.execute("SELECT * FROM builds WHERE id = ?", (build_id,)).fetchone()
        return build_to_dict(connection, row)


@app.get("/api/builds")
def list_builds() -> list[dict]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM builds ORDER BY updated_at DESC").fetchall()
        return [build_to_dict(connection, row) for row in rows]


@app.get("/api/builds/{build_id}")
def get_build(build_id: int) -> dict:
    with db() as connection:
        row = connection.execute("SELECT * FROM builds WHERE id = ?", (build_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="方案不存在")
        return build_to_dict(connection, row)


@app.post("/api/builds")
def create_build(payload: BuildIn) -> dict:
    return save_build(payload)


@app.put("/api/builds/{build_id}")
def update_build(build_id: int, payload: BuildIn) -> dict:
    return save_build(payload, build_id)


@app.delete("/api/builds/{build_id}")
def delete_build(build_id: int) -> dict:
    with db() as connection:
        cursor = connection.execute("DELETE FROM builds WHERE id = ?", (build_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="方案不存在")
        return {"ok": True}


@app.get("/api/export")
def export_backup() -> JSONResponse:
    """导出一份可读的 JSON 备份；恢复仍以 data/backups 里的 sqlite 为准。"""
    with db() as connection:
        categories = [dict(row) for row in connection.execute("SELECT name FROM categories ORDER BY sort_order, name")]
        catalog_items = [dict(row) for row in connection.execute("SELECT * FROM catalog_items ORDER BY category, name")]
        builds = [build_to_dict(connection, row) for row in connection.execute("SELECT * FROM builds ORDER BY id")]
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return JSONResponse(
        {
            "version": 1,
            "exported_at": now_iso(),
            "categories": categories,
            "catalog_items": catalog_items,
            "builds": builds,
        },
        headers={"Content-Disposition": f'attachment; filename="builddesk-export-{stamp}.json"'},
    )


@app.get("/api/compare")
def compare_builds(ids: str = Query(..., description="Comma-separated build ids")) -> list[dict]:
    try:
        build_ids = [int(value) for value in ids.split(",") if value.strip()]
    except ValueError as error:
        raise HTTPException(status_code=400, detail="方案编号格式不正确") from error
    if not build_ids or len(build_ids) > 4:
        raise HTTPException(status_code=400, detail="一次请选择 1 到 4 个方案")
    with db() as connection:
        result = []
        for build_id in build_ids:
            row = connection.execute("SELECT * FROM builds WHERE id = ?", (build_id,)).fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail=f"方案 {build_id} 不存在")
            result.append(build_to_dict(connection, row))
        return result
