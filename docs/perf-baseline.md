# 性能基准与卡顿来源清单

> 2026-09-30 记录。测量方法可复跑：改动前后同一脚本对比。
> 运行环境：Node v22.14.0（vitest），后续浏览器实测另行标注。

## 卡顿来源清单（播放期间可复现的主线程/内存压力点）

| # | 场景 | 根因 | 规模 |
|---|------|------|------|
| S1 | osucad 预览开着时改格子/谱面集 | `cad.invalidate` → `Osz.buildBytes` → `packZip` 对**整个谱面集**重算 CRC32（fflate ZipDeflate level0），主线程串行 | 50MB 谱面集 ≈ **150ms** 帧冻结/次；iframe 与页面共享主线程，预览播放同步卡 |
| S2 | 整包下载 / 组装打包 / osz 导出 | 同上 CRC32（本次为必要路径，无可缓存基线） | ~310MB/s，即每 100MB 数据 ≈ 320ms 主线程占用 |
| S3 | 上传解析阶段 | `decodeMeta` 每文件：源字节 slice 拷贝一份 + `decodeAudioData` 全量 PCM 解码（float32×声道×采样率×时长）+ 主线程 200 桶峰值扫描；4 路并发叠加 | 单 wav：原始大小 + 等量拷贝 + 解码后 ~5-40MB 瞬时；峰值扫描 ~1M 次迭代/10s 音频 |
| S4 | `sha256Hex` | `digest` 前 `slice()` 全量复制（digest 不 detach buffer，纯冗余） | 每文件 +1 倍源大小瞬时分配 |
| S5 | 文件表长列表 | 每行 canvas 位图常驻显存/内存（离屏不释放），加每行 2 个 Observer 实例 | 每行 ~115KB 位图（200×36@dpr2）；500 行 ≈ 57MB + 1000 observer |
| S6 | 播放进度 UI | `timeupdate` 仅 ~4Hz → 波形进度条跳变（视觉卡顿，非音频卡顿） | 250ms 级跳变 |
| S7 | cad 预览重建 | `loadFileBytes` 每次重建重拉全部格子项字节（HTTP 缓存可命中，但仍走网络栈+拷贝） | 每次重建全量重拉 |
| S8 | `Osz.buildBytes` | 产物先攒 chunks 数组再 concat → 双倍峰值分配 | 输出大小 ×2 瞬时 |

## 基线数字（改动前）

- `packZip` 12×4MB=48MB STORE 打包（vitest，本机）：**152–160ms/run**（≈310MB/s，几乎全是 CRC32）
- `decodeMeta` 内存模型：每文件 `source + copy + Float32 PCM`；并发 4 路 → 峰值 ≈ 4×(源+PCM)
- `sha256Hex`：每文件额外 +源大小 临时分配
- 波形画布：每行位图 `width×36×dpr²` bytes，离屏不释放
- 播放器：progress 更新 4Hz；`preload='metadata'`

## 改动后（2026-09-30 实施）

| 项 | 前 | 后 | 手段 |
|----|----|----|------|
| packZip 冷路径（48MB 全新数据） | 152–160ms | ~103–147ms | 自写零拷贝 STORE writer（去描述符/对象分配），CRC32 分片让出主线程（16MB/片） |
| packZip 热路径（48MB 未变数据，cad 重建） | 152–160ms | **≈0.05ms** | CRC32 按 Uint8Array 身份 WeakMap 缓存 |
| cad 预览重建加载 | 每次全量 fetch 格子字节 | 命中内存缓存 | `byteCache` 按 files.id 缓存，`cad.close()` 清空 |
| wav 元数据解析 | decodeAudioData 全量 PCM + 拷贝 | **0 额外分配** | PCM/float wav 直扫 data 块取峰；扫描分片让出（4M 帧/片） |
| sha256Hex | +1 份全量拷贝 | 零拷贝 | digest 直接吃 Uint8Array 视图 |
| 波形画布显存 | 每行常驻 ~115KB（500 行 ≈57MB） | 离屏即释放 | `canvas.width=0` on exit；进入视口才分配 |
| peaks 缓存 | 无上限 | ≤2000 条（≈3.2MB）+ LRU | Map 插入序逐出，在途请求豁免 |
| peaksMap（FileTable） | 翻页累积 | 随 files 集裁剪 | $effect prune |
| 播放进度 UI | 4Hz 跳变 | rAF 逐帧 | timeupdate/seeked 兜底（后台标签页 rAF 节流时） |
| 播放缓冲 | preload=metadata | preload=auto | 防中段欠载 |

## 行为边界（显式收紧，非破坏）

- zip 产物 >4GiB / 单条目 >4GiB / 条目数 >65535：原静默截断产坏包 → 现显式报错（非 ZIP64，同 fflate 上限）
- 验证：vitest 184 全绿（unzipSync 交叉验证产物）；Chromium 实测整包下载 Blob 兜底产物合法
  （PK 魔数+EOCD+CRC+RIFF 数据位正确）、播放中并发打包 currentTime 单调推进零停顿

## 复测脚本

packZip 基准为临时 vitest 用例（48MB 冷/热各 3 轮，验证期自 `/tmp/hs-perf/packzip-bench.test.ts` 恢复）；
浏览器侧 wrangler pages dev（临时目录 + `-b` 假值 + `--persist-to` 独立状态）+ headless Chromium 实测。
