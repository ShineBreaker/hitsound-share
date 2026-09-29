# hitsound-share 技术方案 v3（v2 + 内容寻址去重）

> 本文档为设计期技术方案快照，随源码共享；实现与本文有出入时以 `schema.sql` 与代码为准。
> 已知差异：最终未建 folders 表（树由 `files.folder_path` 聚合得出）；包大小/条目上限以 `src/lib/server/upload.ts` 实现为准。

> 前置：requirements-consensus.md（需求共识）
> 审查：oracle/review.md（5 必改项已在 v2 合入）
> v3 变更：应用户要求加入跨包去重 —— 内容寻址存储（CAS），兼得"秒传"、存储水位减压、R2 key 特殊字符消解

## 总体架构

单仓库 SvelteKit 应用，`adapter-cloudflare` 部署到 **Cloudflare Pages**（*.pages.dev）：

```
浏览器 (SvelteKit, shell 预渲染)
  ├── 静态资源 ──────────── Pages 免费静态请求（不限量）
  ├── API（SvelteKit server endpoints → Pages Functions，10 万请求/天）
  │     ├── /api/auth/*        osu! OAuth v2 回调、HMAC 签名 cookie session
  │     ├── /api/tree          D1 查询包/文件夹层级树
  │     ├── /api/files         D1 查询文件列表（分页，不含 peaks_json）
  │     ├── /api/waveform/<id> 单文件波形 peaks（按需拉取）
  │     ├── /f/<id>            音频流：Functions 从 R2 绑定代理读取，支持 Range
  │     ├── /f/<id>/download   单文件下载（attachment）
  │     ├── /p/<id>/download   整包下载：回放原始 zip
  │     └── /api/upload        manifest 校验（含 hash）+ 返回缺失 blob 清单 + 直传凭证
  ├── R2 对象存储（10GB 免费，egress 免费；CORS 已配置：*.pages.dev + localhost:5173）
  │     ├── blobs/<hash[0:2]>/<sha256>.<ext>   ← 内容寻址，跨包共享（去重核心）
  │     └── packages/<pid>/original.zip
  └── D1（SQLite，5GB 免费）【database_id 1321deab-339a-43ca-85c4-59291542177b】
        users(osu_id PK, username, avatar_url, is_admin)
        packages(id, name, uploader_osu_id, created_at, size_bytes, file_count, status)
        folders(id, package_id, path, parent_id)            -- 树 = zip 内文件夹层级
        files(id, package_id, folder_id, name, format, duration_s, sample_rate,
              bit_depth, channels, size_bytes, peaks_json, blob_hash → blobs.hash)
        blobs(hash PK, size, mime, refcount, created_at)    -- 去重账本
        索引：files(package_id, folder_id)
```

## 去重设计（v3 核心）

- **内容寻址**：每个音频文件的 R2 key = `blobs/<sha256前2位>/<sha256>.<ext>`，由内容决定；相同内容跨包只存一份物理对象。
- **files 表按包保留逻辑条目**：每个包内每个文件一行（各自的路径/文件名/元数据），指向 blob_hash——浏览体验不变，物理存储去重。
- **秒传**：上传 manifest 携带每文件 sha256（浏览器 `crypto.subtle` 计算，lasse 库 497MB 实测几秒）→ 服务端查 blobs 表 → 只返回缺失清单，浏览器只传缺失 blob。第二个用户传含相同文件的包时流量和时间为零。
- **删除用引用计数**：删包 → 该包 files 各行对应 blobs.refcount-- → 归零才删 R2 对象。
- **附带收益**：R2 key 全为生成字符（哈希/ID），用户路径中的 `#`、空格、`&`（lasse 库实测存在）只存 D1 字段，URL 编码坑被架构消解；sha256 天然是完整性校验。
- **实证预期**：lasse 库内部多套皮肤目录（`#default skin`、`#edited default`、`#lks hitsound pack`）预计有可观重复率，多用户上传同类包时收益更大。

## 关键流程

### 上传（登录后）
1. 浏览器 fflate 枚举 zip，白名单过滤（wav/ogg/mp3），逐文件：sha256 + decodeAudioData 元数据 + RIFF 头位深 + 波形 peaks
2. POST /api/upload（manifest：包名 + 每文件{hash,size,path,meta}）→ **服务端强校验**：条目数 ≤5000、音频累计 ≤1GB、白名单、路径拒 `..` → 建 pending 记录，返回 **缺失 blob 清单** + 各自预签名 PUT URL（aws4fetch 生成）
3. 浏览器仅直传缺失 blob 与 original.zip（R2 CORS 已放行 PUT）
4. POST /api/upload/done → **闭环核验**：R2 head() 大小比对 + Range GET 前 16 字节魔数（RIFF/OggS/ID3|0xFFFB）→ 置 visible，blobs.refcount 补齐
5. 孤儿 pending：上传新包时懒清理该用户超 24h 的 pending

### 防滥用分层
- 单包 ≤1GB / ≤5000 条目（按真实素材校准：lasse 库 497MB/2429 文件）；每用户 5 包/天
- **全局存储水位 ≥8GB 拒新上传**（blobs 表 SUM(size) 实时可得）
- manifest 强校验防 D1 写配额攻击

### 试听 / 下载
- `<audio src="/f/<id>">`：Functions 从 R2 绑定读 blob，单区间 206 + 显式 Content-Length，多区间回退 200，ETag=sha256，`Cache-Control: immutable`
- 单文件下载：attachment + 原始文件名（D1 里的 path，URL 编码输出）
- 整包下载：回放 original.zip（oracle 裁决维持双存储）

### 鉴权与治理
- osu! OAuth 授权码模式（identify）；HMAC 签名 cookie；管理员 = ADMIN_OSU_ID 环境变量
- 删除：上传者删自己 / 管理员删任意 → D1 级联 + refcount → 0 时删 R2

### i18n
`zh.ts` 字典 + `t()`，预留 `en.ts`。

## 已验证事实（2026-09-29 真实环境）

| 项 | 结果 |
|---|---|
| R2 桶 hitsound-files + D1 创建 | ✅ account d0c485ac… |
| 真实文件（wav/mp3/ogg、空格/#路径、3 层深）put→get→MD5 | ✅ 5/5 字节级一致 |
| Range 分段请求（模拟播放器） | ✅ 206 + Content-Range + Accept-Ranges，RIFF 头正确 |
| Content-Type 透传 | ✅ audio/wav 保留 |
| CORS（*.pages.dev 通配 + localhost 精确端口） | ✅ 已配置并回读（注意：部分通配 `localhost:*` 不被接受） |
| r2.dev | 已启用验证后关闭 |
| wrangler 坑 | object 操作须 `--remote`；cors 子命令用 `--file`、CF 风格 schema |
| 预签名直传（aws4fetch） | ⏳ 待用户创建 R2 API token 后验证 |

## Argon 主题落地

CSS 变量 `--accent:#8c66ff`、`--accent-pink:#ff66aa`、`--bg-l1:#1b171c/l2:#28222a/l3:#362e38`；圆角 5px 基准；Exo 2 替代 Torus；波形 canvas 紫色渐变。

## 安全基线

白名单+配额+水位；路径仅 D1 字符串；Svelte 默认转义；服务端出网仅 osu.ppy.sh；CSP default-src 'self'。

## 交付里程碑

1. **M1 骨架**：SvelteKit + Argon 主题 + 树/表/波形（lasse 库真实数据形态驱动）
2. **M2 上传链路**：OAuth → manifest+hash 校验 → 秒传判定 → 直传 → 闭环核验
3. **M3 试听/下载/治理**：Range 播放 + 单文件/整包下载 + refcount 删除
4. **M4 打磨与部署**：跳播、空态、i18n 收口、pages.dev 端到端实测
