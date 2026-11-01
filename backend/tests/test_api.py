"""BuildDesk 后端回归测试。

不依赖网络与真实数据库：每个用例在 ``tests/.tmp`` 下建独立库，跑完删除。
运行方式（在 backend 目录）::

    .venv\\Scripts\\python.exe -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

BACKEND_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from fastapi import HTTPException  # noqa: E402

from app import main as m  # noqa: E402

TMP_ROOT = pathlib.Path(__file__).resolve().parent / ".tmp"
_MISSING = object()


class BackendTestCase(unittest.TestCase):
    """把模块级数据库路径重定向到临时目录，避免碰真实数据。"""

    def setUp(self) -> None:
        TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="case-", dir=TMP_ROOT))
        self._saved: dict[str, object] = {}
        overrides = {
            "DATA_DIR": self.tmp,
            "DB_PATH": self.tmp / "test.sqlite3",
            "BACKUP_DIR": self.tmp / "backups",
        }
        for name, value in overrides.items():
            self._saved[name] = getattr(m, name, _MISSING)
            setattr(m, name, value)
        m.init_db()

    def tearDown(self) -> None:
        for name, value in self._saved.items():
            if value is _MISSING:
                if hasattr(m, name):
                    delattr(m, name)
            else:
                setattr(m, name, value)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers ---------------------------------------------------------

    def catalog(self, **kwargs):
        """list_catalog 的 Query 默认值不能直接透传，这里显式补 None。"""
        kwargs.setdefault("category", None)
        kwargs.setdefault("q", None)
        return m.list_catalog(**kwargs)

    def make_catalog_item(self, **kwargs) -> m.CatalogItem:
        payload = {"category": "CPU", "name": "i5-12400", "price": 100.0}
        payload.update(kwargs)
        return m.create_catalog(m.CatalogItemIn(**payload))


class SeedAndCatalogTests(BackendTestCase):
    def test_fresh_database_seeds_demo_catalog(self) -> None:
        self.assertEqual(len(self.catalog()), 21)
        with m.connect() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) AS c FROM categories").fetchone()["c"], 14)

    def test_hidden_categories_never_listed(self) -> None:
        with m.connect() as connection:
            connection.execute(
                "INSERT INTO catalog_items(category, name, price, specs, capacity_tb, power_w, notes, updated_at)"
                " VALUES ('系统', 'Windows 11', 0, '', 0, 0, '', '2026-01-01T00:00:00+00:00')"
            )
        self.assertEqual(len(self.catalog()), 21)
        self.assertEqual([item.name for item in self.catalog(category="系统")], [])

    def test_catalog_crud_roundtrip(self) -> None:
        created = self.make_catalog_item(price=123.0)
        self.assertIn(created.id, [item.id for item in self.catalog()])
        updated = m.update_catalog(created.id, m.CatalogItemIn(category="CPU", name="i5-12600", price=456.0))
        self.assertEqual(updated.name, "i5-12600")
        self.assertEqual(updated.price, 456.0)
        m.delete_catalog(created.id)
        self.assertNotIn(created.id, [item.id for item in self.catalog()])

    def test_missing_records_return_404(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            m.update_catalog(404404, m.CatalogItemIn(category="CPU", name="x"))
        self.assertEqual(ctx.exception.status_code, 404)
        with self.assertRaises(HTTPException) as ctx:
            m.delete_catalog(404404)
        self.assertEqual(ctx.exception.status_code, 404)


class BuildSnapshotTests(BackendTestCase):
    def test_totals_are_computed_on_read(self) -> None:
        build = m.save_build(
            m.BuildIn(
                name="nas",
                kind="低功耗 / NAS",
                items=[
                    m.BuildItemIn(category="硬盘", name="HC530", quantity=2, unit_price=950, capacity_tb=14, power_w=8),
                    m.BuildItemIn(category="CPU", name="i3-8100", quantity=1, unit_price=88, power_w=35),
                ],
            )
        )
        self.assertEqual(build["total"], 1988.0)
        self.assertEqual(build["total_power_w"], 51.0)
        self.assertEqual(build["total_capacity_tb"], 28.0)
        self.assertEqual(build["disk_count"], 2)

    def test_snapshot_survives_catalog_deletion(self) -> None:
        item = self.make_catalog_item(category="显卡", name="RTX 4090", price=9999)
        build = m.save_build(
            m.BuildIn(
                name="gpu",
                items=[m.BuildItemIn(catalog_item_id=item.id, category="显卡", name="RTX 4090", unit_price=9999)],
            )
        )
        m.delete_catalog(item.id)
        reloaded = m.get_build(build["id"])
        self.assertEqual(len(reloaded["items"]), 1)
        self.assertIsNone(reloaded["items"][0]["catalog_item_id"])
        self.assertEqual(reloaded["items"][0]["name"], "RTX 4090")
        self.assertEqual(reloaded["items"][0]["unit_price"], 9999)

    def test_update_missing_build_returns_404(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            m.save_build(m.BuildIn(name="ghost", items=[]), 999999)
        self.assertEqual(ctx.exception.status_code, 404)


class CompareTests(BackendTestCase):
    def test_compare_rejects_empty_and_too_many(self) -> None:
        for ids in ("", "1,2,3,4,5"):
            with self.assertRaises(HTTPException) as ctx:
                m.compare_builds(ids)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_compare_rejects_garbage_and_missing(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            m.compare_builds("abc")
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            m.compare_builds("999999")
        self.assertEqual(ctx.exception.status_code, 404)


class QueryNormalizationTests(BackendTestCase):
    def test_cpu_query_aliases(self) -> None:
        self.assertEqual(m.normalize_cpu_query("i5-12400"), "i512400")
        self.assertEqual(m.normalize_cpu_query("英特尔i5 12400"), "i512400")
        self.assertEqual(m.normalize_cpu_query("锐龙5 5600G"), "ryzen55600g")

    def test_cpu_match_scoring(self) -> None:
        item = {"model": "i5-12400", "name": "Intel Core i5-12400"}
        self.assertEqual(m.cpu_match_score(m.normalize_cpu_query("i5-12400"), item), 100)
        self.assertEqual(m.cpu_match_score(m.normalize_cpu_query("12400"), item), 95)
        self.assertEqual(m.cpu_match_score(m.normalize_cpu_query("i5-12400F"), item), 0)

    def test_gpu_query_aliases(self) -> None:
        self.assertEqual(m.normalize_gpu_query("RTX 4060"), "rtx4060")
        self.assertEqual(m.normalize_gpu_query("英伟达RTX4060"), "nvidiartx4060")


class SeedOnceTests(BackendTestCase):
    def test_second_init_does_not_resurrect_demo_rows(self) -> None:
        with m.db() as connection:
            self.assertEqual(connection.execute("SELECT value FROM meta WHERE key='seeded'").fetchone()["value"], "1")
            connection.execute("DELETE FROM catalog_items")
        self.assertEqual(len(self.catalog()), 0)

        m.init_db()

        self.assertEqual(len(self.catalog()), 0, "清空报价库后重启不应复活演示数据")

    def test_existing_database_without_meta_is_marked_not_seeded(self) -> None:
        with m.db() as connection:
            connection.execute("DELETE FROM meta")
        before = len(self.catalog())

        m.init_db()

        self.assertEqual(len(self.catalog()), before)
        with m.db() as connection:
            self.assertIsNotNone(connection.execute("SELECT value FROM meta WHERE key='seeded'").fetchone())


class DatabaseHandleTests(BackendTestCase):
    def test_db_closes_connection(self) -> None:
        with m.db() as connection:
            self.assertEqual(connection.execute("SELECT 1 AS x").fetchone()["x"], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")


class BackupTests(BackendTestCase):
    def test_backup_creates_copy_and_rotates(self) -> None:
        m.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        for index in range(12):
            (m.BACKUP_DIR / f"hardware_helper-20000101-0000{index:02d}.sqlite3").write_bytes(b"old")

        target = m.backup_database()

        self.assertIsNotNone(target)
        self.assertTrue(target.exists())
        remaining = sorted(m.BACKUP_DIR.glob("hardware_helper-*.sqlite3"))
        self.assertEqual(len(remaining), m.BACKUP_KEEP)
        self.assertIn(target, remaining)

    def test_backup_skips_missing_database(self) -> None:
        m.DB_PATH.unlink()
        self.assertIsNone(m.backup_database())
        self.assertFalse(m.BACKUP_DIR.exists())


class ExportTests(BackendTestCase):
    def test_export_payload_contains_everything(self) -> None:
        m.save_build(
            m.BuildIn(
                name="导出用方案",
                items=[m.BuildItemIn(category="CPU", name="i5-12400", quantity=2, unit_price=100)],
            )
        )

        response = m.export_backup()
        payload = json.loads(response.body)

        self.assertEqual(payload["version"], 1)
        self.assertEqual(len(payload["categories"]), 14)
        self.assertEqual(len(payload["catalog_items"]), 21)
        self.assertEqual(len(payload["builds"]), 1)
        self.assertEqual(payload["builds"][0]["name"], "导出用方案")
        self.assertEqual(payload["builds"][0]["total"], 200.0)
        self.assertIn("attachment;", response.headers["content-disposition"])


class DatasetCacheTests(BackendTestCase):
    """在线数据：失败要报失败，且不能每次输入都重新打网络。"""

    CPU_ROW = {"model": "i5-12400", "name": "Intel Core i5-12400", "vendor": "Intel"}
    GPU_ROW = {"name": "GeForce RTX 4060", "gpu_name": "RTX 4060"}

    def setUp(self) -> None:
        super().setUp()
        self._saved_datasets = (m._cpu_dataset, m._gpu_dataset)
        m._cpu_dataset = m._DatasetCache(m.CPU_CACHE_TTL_SECONDS)
        m._gpu_dataset = m._DatasetCache(m.GPU_CACHE_TTL_SECONDS)

    def tearDown(self) -> None:
        m._cpu_dataset, m._gpu_dataset = self._saved_datasets
        super().tearDown()

    def test_failure_backs_off_instead_of_retrying_every_call(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=None) as fetch:
            self.assertEqual(m.load_cpu_dataset(), ([], False))
            self.assertEqual(m.load_cpu_dataset(), ([], False))
        self.assertEqual(fetch.call_count, 1, "退避窗口内不应重复下载")

    def test_force_refresh_bypasses_backoff(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=None) as fetch:
            m.load_cpu_dataset()
            m.load_cpu_dataset(force=True)
        self.assertEqual(fetch.call_count, 2)

    def test_refresh_without_cache_reports_unavailable(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                m.refresh_cpu_dataset()
        self.assertEqual(ctx.exception.status_code, 503)

    def test_refresh_with_stale_cache_reports_failure_not_success(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=[self.CPU_ROW]):
            rows, fresh = m.load_cpu_dataset(force=True)
        self.assertTrue(fresh)
        self.assertEqual(len(rows), 1)

        with mock.patch.object(m, "_fetch_cpu_rows", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                m.refresh_cpu_dataset()

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertIn("缓存", ctx.exception.detail)

    def test_successful_refresh_clears_error_state(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=None):
            m.load_cpu_dataset()
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=[self.CPU_ROW]):
            result = m.refresh_cpu_dataset()

        self.assertTrue(result["ok"])
        self.assertEqual(result["count"], 1)
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=[self.CPU_ROW]) as fetch:
            m.load_cpu_dataset()
        self.assertEqual(fetch.call_count, 0, "成功刷新后应命中缓存")

    def test_gpu_refresh_failure_is_reported(self) -> None:
        with mock.patch.object(m, "_fetch_gpu_rows", return_value=[self.GPU_ROW]):
            m.load_gpu_dataset(force=True)
        with mock.patch.object(m, "_fetch_gpu_rows", return_value=None):
            with self.assertRaises(HTTPException) as ctx:
                m.refresh_gpu_dataset()
        self.assertEqual(ctx.exception.status_code, 503)

    def test_lookup_uses_cached_dataset(self) -> None:
        with mock.patch.object(m, "_fetch_cpu_rows", return_value=[self.CPU_ROW]):
            m.load_cpu_dataset()
        self.assertEqual(len(m.lookup_cpu("i5-12400")), 1)
        self.assertEqual(m.lookup_cpu("xxxxxxxx"), [])


class ValidationTests(BackendTestCase):
    def test_unknown_or_hidden_category_is_rejected(self) -> None:
        for category in ("系统", "不存在的分类"):
            with self.assertRaises(HTTPException) as ctx:
                self.make_catalog_item(category=category)
            self.assertEqual(ctx.exception.status_code, 400)

    def test_blank_names_are_rejected(self) -> None:
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            m.CatalogItemIn(category="CPU", name="   ")
        with self.assertRaises(ValidationError):
            m.BuildIn(name="   ")
        with self.assertRaises(ValidationError):
            m.BuildItemIn(category="CPU", name="  ")

    def test_names_are_stripped(self) -> None:
        created = self.make_catalog_item(name="  i5-12400  ")
        self.assertEqual(created.name, "i5-12400")

    def test_capacity_and_power_follow_category(self) -> None:
        cpu = self.make_catalog_item(category="CPU", name="容量不该存在", capacity_tb=5)
        self.assertEqual(cpu.capacity_tb, 0)
        case = self.make_catalog_item(category="机箱", name="功耗不该存在", power_w=10)
        self.assertEqual(case.power_w, 0)
        disk = self.make_catalog_item(category="硬盘", name="该有容量", capacity_tb=14, power_w=8)
        self.assertEqual(disk.capacity_tb, 14)
        self.assertEqual(disk.power_w, 8)

    def test_build_items_are_normalized_too(self) -> None:
        build = m.save_build(
            m.BuildIn(
                name="normalize",
                items=[m.BuildItemIn(category="机箱", name="ATX", quantity=1, unit_price=300, power_w=99)],
            )
        )
        self.assertEqual(build["items"][0]["power_w"], 0)


class SearchTests(BackendTestCase):
    def test_like_wildcards_are_literal(self) -> None:
        self.make_catalog_item(category="CPU", name="zzz_underscore")
        self.make_catalog_item(category="CPU", name="zzzXunderscore")
        self.make_catalog_item(category="CPU", name="zzz100%off")
        self.make_catalog_item(category="CPU", name="zzz100Xoff")

        underscore_hits = [item.name for item in self.catalog(q="zzz_underscore")]
        percent_hits = [item.name for item in self.catalog(q="zzz100%off")]

        self.assertEqual(underscore_hits, ["zzz_underscore"])
        self.assertEqual(percent_hits, ["zzz100%off"])
        self.assertNotIn("zzzXunderscore", [item.name for item in self.catalog(q="_")])

    def test_plain_search_still_works(self) -> None:
        self.assertIn("Intel N100", [item.name for item in self.catalog(q="N100")])


class CategoryMetadataTests(BackendTestCase):
    def test_categories_expose_storage_and_power_flags(self) -> None:
        rows = {row["name"]: row for row in m.categories()}
        self.assertEqual(len(rows), 14)
        self.assertTrue(rows["硬盘"]["storage"])
        self.assertTrue(rows["硬盘"]["power"])
        self.assertTrue(rows["SSD"]["storage"])
        self.assertFalse(rows["机箱"]["storage"])
        self.assertFalse(rows["机箱"]["power"])
        self.assertFalse(rows["CPU"]["storage"])
        self.assertTrue(rows["CPU"]["power"])


if __name__ == "__main__":
    unittest.main()
