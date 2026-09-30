-- hitsound-share D1 schema (v5, 文件级所有者)
-- 树结构说明：不设 folders 表，树由 files.folder_path 前缀聚合得出（DISTINCT + 前缀分组），
-- 消除整层关联；空文件夹不保留（可接受损失）。
-- v3→v4 线上变更：ALTER TABLE packages ADD COLUMN append_to TEXT;
-- v4→v5 线上变更（顺序执行，回填前老代码不受影响）：
--   ALTER TABLE files ADD COLUMN owner_osu_id INTEGER REFERENCES users(osu_id) ON DELETE SET NULL;
--   UPDATE files SET owner_osu_id = (SELECT uploader_osu_id FROM packages WHERE packages.id = files.package_id);
-- （v4 起 original.zip 停传停存，整包下载由浏览器按 files 实时打包）

CREATE TABLE IF NOT EXISTS users (
  osu_id    INTEGER PRIMARY KEY,          -- osu! 用户 ID
  username  TEXT NOT NULL,
  avatar_url TEXT,
  is_admin  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS packages (
  id        TEXT PRIMARY KEY,             -- uuid
  name      TEXT NOT NULL,
  uploader_osu_id INTEGER REFERENCES users(osu_id) ON DELETE SET NULL,  -- NULL = 系统导入
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  size_bytes INTEGER NOT NULL,            -- 历史遗留：original.zip 大小（v4 起新包恒 0，无 zip）
  logical_size INTEGER NOT NULL,          -- 包内文件累计大小（含重复）
  file_count INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'visible',  -- pending / visible
  append_to TEXT                          -- 影子 pending 包指向合并目标（visible 包恒 NULL）
);

CREATE TABLE IF NOT EXISTS blobs (
  hash      TEXT PRIMARY KEY,             -- sha256 hex
  size      INTEGER NOT NULL,
  mime      TEXT NOT NULL,
  refcount  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id        TEXT PRIMARY KEY,             -- uuid
  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  folder_path TEXT NOT NULL DEFAULT '',   -- 相对包根的文件夹路径，'' = 包根
  name      TEXT NOT NULL,
  format    TEXT NOT NULL,                -- wav / ogg / mp3
  duration_s REAL,                        -- 未知为 NULL
  sample_rate INTEGER,
  bit_depth INTEGER,                      -- 有损格式为 NULL
  channels  INTEGER,
  size_bytes INTEGER NOT NULL,
  peaks     TEXT,                         -- JSON 数组 ~200 峰值(0-1)，未知为 NULL
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  owner_osu_id INTEGER REFERENCES users(osu_id) ON DELETE SET NULL  -- 上传者（文件级所有权）；NULL = 系统导入，仅管理员可动
);

CREATE INDEX IF NOT EXISTS idx_files_pkg_folder ON files(package_id, folder_path);
CREATE INDEX IF NOT EXISTS idx_files_blob ON files(blob_hash);
