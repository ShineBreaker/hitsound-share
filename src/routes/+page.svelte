<script lang="ts">
	// 主页：左树（顶层 = 各包 → 包内文件夹层级）+ 右表（当前选中文件夹的文件）
	// 数据全部客户端运行时拉取（shell 预渲染只烘壳，不烘数据——config 依赖部署期环境变量，
	// 树数据需随库更新）；播放用单个 Audio 元素逐个点播。
	// 整包下载 = 按当前内容实时拼 zip（服务端拼包受免费计划 50 子请求限制不可行）：
	// 拉清单 → 并发直连 R2 拉去重 blob → fflate 流式 STORE 打包 → Blob 保存
	import { onMount } from 'svelte';
	import { Zip, ZipDeflate } from 'fflate';
	import TreeView from '$lib/components/TreeView.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import KitBuilder from '$lib/components/KitBuilder.svelte';
	import {
		fetchTree,
		fetchFiles,
		fetchMe,
		fetchZipManifest,
		buildForest,
		parseNodeKey,
		renamePackage,
		renameFolder,
		type TreePackage,
		type Me
	} from '$lib/api';
	import { t } from '$lib/i18n';
	import type { FileRow } from '$lib/types';

	let packages = $state<TreePackage[]>([]);
	let selected = $state('');
	let files = $state<FileRow[]>([]);
	let total = $state(0);
	let loading = $state(false);
	let loadError = $state(false); // 文件列表加载失败
	let treeLoaded = $state(false); // 树已成功加载（区分「加载中」与「库为空」）
	let treeError = $state(false); // 树加载失败
	let moreLoading = $state(false); // 「加载更多」请求进行中（防连点重复追加）
	let pageSeq = 0; // 文件页请求序号：只接受最新请求的响应，防止快速切换文件夹时旧响应后到覆盖
	let me = $state<Me>({ loggedIn: false }); // 登录态（树节点改名按钮显示）
	let editingKey = $state(''); // 行内编辑中的树节点 key

	const PAGE_SIZE = 200;

	// 整包下载状态机：idle / packing（x/y）/ error
	let dlState = $state<'idle' | 'packing' | 'error'>('idle');
	let dlDone = $state(0);
	let dlTotal = $state(0);

	// 播放器状态（audio 元素在 onMount 创建，避免 SSR 引用 window）
	let audio: HTMLAudioElement | null = null;
	let playingId = $state<string | null>(null);
	let paused = $state(true);
	let progress = $state(0);
	let pendingSeek: number | null = null;
	let playingFile: FileRow | null = null;

	const forest = $derived(buildForest(packages));
	const treeLoading = $derived(!treeLoaded && !treeError);

	// 面包屑：包名 > 文件夹各级（可点各级回跳）
	const crumbs = $derived.by(() => {
		const { pkg, folder } = parseNodeKey(selected);
		const p = packages.find((x) => x.id === pkg);
		if (!p) return [] as Array<{ name: string; key: string }>;
		const list = [{ name: p.name, key: `pkg:${p.id}` }];
		let acc = '';
		for (const seg of folder ? folder.split('/') : []) {
			acc = acc ? `${acc}/${seg}` : seg;
			list.push({ name: seg, key: `pkg:${p.id}/${acc}` });
		}
		return list;
	});

	const currentPkgId = $derived(parseNodeKey(selected).pkg);

	async function loadPage(key: string, append: boolean): Promise<void> {
		const { pkg, folder } = parseNodeKey(key);
		if (!pkg) return;
		if (append) {
			if (moreLoading) return; // 上一页仍在途，忽略连点
			moreLoading = true;
		} else {
			loading = true;
		}
		loadError = false;
		const seq = ++pageSeq;
		try {
			const res = await fetchFiles(pkg, folder, append ? files.length : 0, PAGE_SIZE);
			if (seq !== pageSeq) return; // 期间已有更新的选择，丢弃过期响应
			files = append ? [...files, ...res.files] : res.files;
			if (!append) total = res.total; // append 页服务端跳过 COUNT 返回 -1，保留首页计数
		} catch {
			if (seq === pageSeq && !append) {
				loadError = true;
				files = [];
			}
		} finally {
			if (seq === pageSeq) {
				loading = false;
				moreLoading = false;
			}
		}
	}

	/** 拉树并默认选中第一个包；树加载失败可重试本流程 */
	async function initTree(): Promise<void> {
		treeError = false;
		try {
			const res = await fetchTree();
			packages = res.packages;
			treeLoaded = true;
			if (packages.length > 0) {
				selected = `pkg:${packages[0].id}`;
				await loadPage(selected, false);
			}
		} catch {
			treeError = true;
		}
	}

	function select(key: string): void {
		if (key === selected) return;
		selected = key;
		void loadPage(key, false);
	}

	/** 并发池：限并发遍历（下载拉取 6 路，兼顾速度与 R2/代理压力） */
	async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
		let next = 0;
		const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		});
		await Promise.all(workers);
	}

	/** 整包下载：清单 → 并发拉取（同 hash 只拉一次，消费完即释放）→ 流式 STORE 打包 → 保存 */
	async function downloadPackage(): Promise<void> {
		const pkgId = currentPkgId;
		if (!pkgId || dlState === 'packing') return;
		dlState = 'packing';
		dlDone = 0;
		try {
			const manifest = await fetchZipManifest(pkgId);
			dlTotal = manifest.files.length;

			// 落盘策略：Chromium 走 File System Access 流式写（内存不随包体线性增长）；
			// 其余浏览器降级内存 Blob（超大包移动端可能吃紧，可接受）
			let handle: FileSystemFileHandle | null = null;
			try {
				handle = await window.showSaveFilePicker({
					suggestedName: `${manifest.name || 'package'}.zip`,
					types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }]
				});
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') {
					dlState = 'idle'; // 用户取消保存对话框，不算失败
					return;
				}
				handle = null;
			}
			const writable = handle ? await handle.createWritable() : null;
			const chunks: Uint8Array[] = [];
			let writeChain = Promise.resolve();
			const zip = new Zip((err, dat) => {
				if (err) throw err;
				if (writable) writeChain = writeChain.then(() => writable.write(dat));
				else chunks.push(dat);
			});
			// hash → 拉取 Promise（去重）+ 剩余引用计数（全部条目消费完即释放缓存）
			const bufCache = new Map<string, Promise<Uint8Array>>();
			const remaining = new Map<string, number>();
			for (const f of manifest.files) remaining.set(f.hash, (remaining.get(f.hash) ?? 0) + 1);
			const getBuf = (hash: string): Promise<Uint8Array> => {
				let p = bufCache.get(hash);
				if (!p) {
					p = fetch(manifest.urls[hash]).then(async (r) => {
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						return new Uint8Array(await r.arrayBuffer());
					});
					bufCache.set(hash, p);
				}
				return p;
			};
			// 条目乱序写入 zip 是合法的（central directory 记录名字，无顺序要求）
			await mapPool(manifest.files, 6, async (f) => {
				const data = await getBuf(f.hash);
				const entry = new ZipDeflate(f.path, { level: 0 }); // STORE 直通，CPU 仅 crc32
				zip.add(entry);
				entry.push(data, true);
				dlDone += 1;
				const left = (remaining.get(f.hash) ?? 1) - 1;
				remaining.set(f.hash, left);
				if (left === 0) bufCache.delete(f.hash);
			});
			zip.end(); // 同步流：返回时 central directory 已收入 chunks/写链
			if (writable) {
				await writeChain;
				await writable.close();
			} else {
				const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
				const a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = `${manifest.name || 'package'}.zip`;
				a.click();
				URL.revokeObjectURL(a.href);
			}
			dlState = 'idle';
		} catch {
			dlState = 'error';
		}
	}

	/** 树强制刷新（绕 60s HTTP 缓存；失败保留旧数据） */
	async function refreshTree(): Promise<void> {
		try {
			const res = await fetchTree(true);
			packages = res.packages;
			treeLoaded = true;
		} catch {
			/* 刷新失败不打断改名流程 */
		}
	}

	/**
	 * 树节点改名提交（大类 = 包名；小类 = 文件夹末级段，父路径保留）。
	 * 成功后强刷树；包 key 是 id 无需重映射，文件夹改名则重映射选中 key 并重载文件页
	 */
	async function submitRename(key: string, newName: string): Promise<boolean> {
		const { pkg, folder } = parseNodeKey(key);
		const name = newName.trim();
		if (!pkg || !name || name.includes('/') || name.includes('\\')) return false;
		// 改后的文件夹全路径（末级替换）
		const slash = folder.lastIndexOf('/');
		const newFolder = folder === '' ? name : slash === -1 ? name : `${folder.slice(0, slash)}/${name}`;
		try {
			if (folder === '') await renamePackage(pkg, name);
			else await renameFolder(pkg, folder, newFolder);
		} catch {
			return false;
		}
		const prev = selected;
		await refreshTree();
		if (folder !== '') {
			const oldKey = `pkg:${pkg}/${folder}`;
			if (prev === oldKey || prev.startsWith(`${oldKey}/`)) {
				selected = `pkg:${pkg}/${newFolder}${prev.slice(oldKey.length)}`;
				void loadPage(selected, false);
			}
		}
		return true;
	}

	/** 点行：未播→播、播放中→暂停、暂停→继续 */
	function togglePlay(file: FileRow): void {
		if (!audio) return;
		if (playingId === file.id) {
			if (audio.paused) void audio.play();
			else audio.pause();
			return;
		}
		playingFile = file;
		playingId = file.id;
		pendingSeek = null;
		// 时长优先用元数据（流式 mp3 的 audio.duration 可能为 Infinity）
		audio.src = `/f/${encodeURIComponent(file.id)}`;
		void audio.play();
	}

	/** 点波形：当前行直接跳；别的行先播、metadata 就绪后再跳 */
	function seek(file: FileRow, ratio: number): void {
		if (!audio) return;
		if (playingId !== file.id) {
			togglePlay(file); // 先切换曲目（内部会清 pendingSeek）
			pendingSeek = ratio; // 再记跳播比例，等 loadedmetadata 应用
			return;
		}
		const dur = file.durationS ?? audio.duration;
		if (Number.isFinite(dur) && dur > 0) audio.currentTime = ratio * dur;
	}

	onMount(() => {
		audio = new Audio();
		audio.preload = 'metadata';
		audio.addEventListener('timeupdate', () => {
			if (!audio || !playingFile) return;
			const dur = playingFile.durationS ?? audio.duration;
			progress = Number.isFinite(dur) && dur > 0 ? audio.currentTime / dur : 0;
		});
		audio.addEventListener('play', () => (paused = false));
		audio.addEventListener('pause', () => (paused = true));
		audio.addEventListener('ended', () => {
			playingId = null;
			playingFile = null;
			progress = 0;
		});
		audio.addEventListener('error', () => {
			// 播放失败（blob 缺失等）：复位，不留假播放态
			playingId = null;
			playingFile = null;
			progress = 0;
		});
		audio.addEventListener('loadedmetadata', () => {
			if (pendingSeek != null && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
				audio.currentTime = pendingSeek * audio.duration;
			}
			pendingSeek = null;
		});

		// 初始加载树并默认选中第一个包（失败可经树面板重试按钮重走本流程）
		void initTree();
		// 登录态：树节点改名按钮的显示判定（失败按未登录处理）
		void fetchMe().then((m) => (me = m));
	});
</script>

<div class="browser">
	<aside class="tree-panel">
		<div class="panel-title"><span>{t('tree.title')}</span></div>
		<nav class="tree">
			{#if treeLoading}
				<div class="hint">{t('table.loading')}</div>
			{:else if treeError}
				<div class="hint">
					{t('error.load')}
					<button class="retry" onclick={() => void initTree()}>{t('action.retry')}</button>
				</div>
			{:else if forest.length === 0}
				<div class="hint">{t('tree.empty')}</div>
			{:else}
			{#each forest as node (node.key)}
				<TreeView
					{node}
					{selected}
					{me}
					bind:editingKey
					onselect={select}
					onsubmit={submitRename}
				/>
			{/each}
			{/if}
		</nav>
	</aside>

	<section class="files-panel">
		<div class="files-head">
			<nav class="crumbs" aria-label={t('app.tagline')}>
				{#each crumbs as c, i (c.key)}
					<button class="crumb" class:last={i === crumbs.length - 1} onclick={() => select(c.key)}>
						{c.name}
					</button>
					{#if i < crumbs.length - 1}<span class="sep">›</span>{/if}
				{/each}
			</nav>
			{#if currentPkgId && packages.length > 0}
				{#if dlState === 'packing'}
					<button class="btn primary" disabled>
						{t('download.packaging', { n: dlDone, total: dlTotal })}
					</button>
				{:else}
					<button
						class="btn primary"
						class:err={dlState === 'error'}
						title={dlState === 'error' ? t('download.failedHint') : ''}
						onclick={() => void downloadPackage()}
					>
						{dlState === 'error' ? t('download.failedRetry') : t('action.downloadPackage')}
					</button>
				{/if}
			{/if}
		</div>

		<div class="files-body">
			{#if loading}
				<div class="hint">{t('table.loading')}</div>
			{:else if loadError}
				<div class="hint">
					{t('error.load')}
					<button class="retry" onclick={() => void loadPage(selected, false)}>{t('action.retry')}</button>
				</div>
			{:else}
				<FileTable
					{files}
					{playingId}
					{paused}
					{progress}
					onplay={togglePlay}
					onseek={seek}
				/>
			{/if}
		</div>

		{#if !loading && !loadError && files.length < total}
			<div class="files-foot">
				<button class="btn" disabled={moreLoading} onclick={() => void loadPage(selected, true)}>
					{moreLoading ? t('table.loading') : `${t('table.loadMore')}（${files.length}/${total}）`}
				</button>
			</div>
		{/if}
	</section>

	<!-- 悬浮组装面板（position:fixed，不占文档流）：拖文件表行到格子，按 <行>-<列><序号> 打包 zip -->
	<KitBuilder />
</div>

<style>
	.browser {
		height: 100%;
		display: grid;
		grid-template-columns: 280px 1fr;
		gap: 14px;
		padding: 14px;
	}

	/* 炭绿卡片浮于橄榄灰页面（编辑器面板层次） */
	.tree-panel,
	.files-panel {
		min-height: 0; /* grid 子项内部滚动 */
		background: var(--bg-l2);
		border: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		border-radius: var(--radius-lg);
		box-shadow: 0 4px 18px rgb(0 0 0 / 0.28);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	/* 节标题：小号弱化 + 文字下缀薄荷短划线（编辑器「颜色」节同款） */
	.panel-title {
		flex: none;
		padding: 12px 14px 9px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
	}
	.panel-title > span {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 2px;
		color: var(--text-faint);
		padding-bottom: 4px;
		border-bottom: 2px solid var(--accent);
	}

	.tree {
		flex: 1;
		overflow: auto;
		padding: 8px;
	}

	.hint {
		padding: 40px 0;
		text-align: center;
		color: var(--text-faint);
	}

	.retry {
		margin-left: 8px;
		padding: 2px 12px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: transparent;
		color: var(--accent-bright);
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.retry:hover {
		background: var(--bg-l3);
	}

	/* 面板头：面包屑 + 整包下载 */
	.files-head {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 12px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		min-height: 46px;
	}

	.crumbs {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 2px;
		min-width: 0;
	}

	.crumb {
		border: none;
		background: transparent;
		color: var(--text-dim);
		font-size: 13px;
		padding: 3px 8px;
		border-radius: var(--radius);
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.crumb:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	/* 末级（当前位置）不可点感 + 高亮 */
	.crumb.last {
		color: var(--accent-bright);
		font-weight: 600;
		cursor: default;
	}
	.crumb.last:hover {
		background: transparent;
	}

	.sep {
		color: var(--text-faint);
		font-size: 12px;
	}

	/* 次级按钮：ghost 浮起；主按钮 .primary：薄荷填充 + 深色文字 */
	.btn {
		flex: none;
		padding: 5px 14px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-size: 13px;
		text-decoration: none;
		cursor: pointer;
		white-space: nowrap;
		transition:
			background 0.15s ease,
			color 0.15s ease,
			border-color 0.15s ease;
	}
	.btn:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	.btn.primary {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 700;
	}
	.btn.primary:hover {
		background: var(--accent-bright);
		color: var(--on-accent);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.btn.primary:disabled:hover {
		background: var(--accent);
		color: var(--on-accent);
	}
	/* 打包失败：按钮变粉提示，点击即重试 */
	.btn.err {
		background: var(--accent-pink);
		color: var(--on-accent);
	}
	.btn.err:hover {
		background: var(--accent-pink);
		color: var(--on-accent);
	}

	.files-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.files-body > :global(.table-wrap) {
		flex: 1;
	}

	.files-foot {
		flex: none;
		display: flex;
		justify-content: center;
		padding: 10px;
		border-top: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
	}
</style>
