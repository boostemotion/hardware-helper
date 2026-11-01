# BuildDesk

整机 / NAS 硬件方案管理器。它把 Excel 里的三件事拆开：报价库、保存方案、方案对比。

## 技术栈

- 前端：React + TypeScript + Vite + lucide-react
- 后端：FastAPI + SQLite
- 运行方式：本机前后端分离，数据保存在 `backend/data/hardware_helper.sqlite3`

## 启动

双击项目根目录的 `启动硬件助手.cmd`：分别启动后端（8000）和前端（5173），
等前端真正可访问后再打开浏览器。首次运行要装依赖，可能要等几分钟。

手动启动（以下命令在项目根目录执行）：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

```powershell
cd frontend
npm ci
npm run dev
```

浏览器打开 `http://localhost:5173`。

`package.json` 里依赖写的是 `latest`，真实版本由 `package-lock.json` 锁定，
请用 `npm ci` 而不是 `npm install`，以免依赖漂移。前端默认访问
`http://127.0.0.1:8000/api`，需要改地址时设置环境变量 `VITE_API_BASE`。

## 数据与备份

- 主数据库：`backend/data/hardware_helper.sqlite3`
- 每次启动会自动复制一份到 `backend/data/backups/`，只保留最近 10 份
- 页面右上角的「导出备份」按钮会下载 JSON（`GET /api/export`），便于查看和迁移
- 恢复方式：先停后端，把 `backups/` 里的 `.sqlite3` 覆盖回 `hardware_helper.sqlite3`，再启动
- 数据库和备份目录都在 `.gitignore` 里，不会被提交

## 当前功能

- 方案直接保存到 SQLite，可继续编辑、删除和复制基础配置
- 报价库按 CPU、主板、内存、显卡、SSD、硬盘等分类查看
- CPU 录入支持常见型号本地识别，也支持在线模糊查询核心、线程、核显和功耗；后端缓存在线数据 24 小时，可在报价库手动更新
- 显卡录入支持在线模糊查询显存、显存类型、位宽、架构、总线和参考功耗；数据同样缓存 24 小时
- 报价录入会按分类显示适用参数：容量仅用于 SSD/硬盘，CPU/显卡等不会显示无关的容量字段
- 加入方案时保存当前单价、容量和功耗快照
- 最多选择 4 个已保存方案进行总价、功耗、容量和配件逐项对比
- 普通整机与 NAS 共用同一套数据模型，NAS 字段可留空或填 0

## 开发

后端测试（不需要联网，也不碰真实数据库）：

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

前端类型检查 / 构建：

```powershell
cd frontend
npx tsc -b
npm run build
```

## 关于在线数据

CPU / GPU 规格来自公开数据集，进程内缓存 24 小时。数据源不可用时：

- 查询接口返回空结果，前端提示可手动填写
- 「更新 CPU 数据 / 更新 GPU 数据」返回 503，并说明仍在使用上次缓存
- 失败后 60 秒内不再重试，避免离线状态下输入框一直卡住
