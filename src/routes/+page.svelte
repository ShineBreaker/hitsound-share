<script lang="ts">
	// 主页：左树（顶层 = 各包 → 包内文件夹层级）+ 右表（当前选中文件夹的文件）
	// 数据全部客户端运行时拉取（shell 预渲染只烘壳，不烘数据——config 依赖部署期环境变量，
	// 树数据需随库更新）；播放用单个 Audio 元素逐个点播
	import { onMount } from 'svelte';
	import TreeView from '$lib/components/TreeView.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import { fetchTree, fetchFiles, buildForest, parseNodeKey, type TreePackage } from '$lib/api';
	import { t } from '$lib/i18n';
	import type { FileRow } from '$lib/types';

	let packages = $state<TreePackage[]>([]);
	let selected = $state('');
	let files = $state<FileRow[]>([]);
	let total = $state(0);
	let loading = $state(false);
	let loadError = $state(false);

	const PAGE_SIZE = 200;

	// 播放器状态（audio 元素在 onMount 创建，避免 SSR 引用 window）
	let audio: HTMLAudioElement | null = null;
	let playingId = $state<string | null>(null);
	let paused = $state(true);
	let progress = $state(0);
	let pendingSeek: number | null = null;
	let playingFile: FileRow | null = null;

	const forest = $derived(buildForest(packages));
	const treeLoading = $derived(packages.length === 0 && !loadError);

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
		if (!append) loading = true;
		loadError = false;
		try {
			const res = await fetchFiles(pkg, folder, append ? files.length : 0, PAGE_SIZE);
			files = append ? [...files, ...res.files] : res.files;
			total = res.total;
		} catch {
			loadError = true;
			if (!append) files = [];
		} finally {
			loading = false;
		}
	}

	function select(key: string): void {
		if (key === selected) return;
		selected = key;
		void loadPage(key, false);
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

	/** 点波形：当前行直接跳；别的行先播再等 metadata 后跳 */
	function seek(file: FileRow, ratio: number): void {
		if (!audio) return;
		if (playingId !== file.id) {
			pendingSeek = ratio;
			togglePlay(file);
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

		// 初始加载树并默认选中第一个包
		void (async () => {
			try {
				const res = await fetchTree();
				packages = res.packages;
				if (packages.length > 0) {
					selected = `pkg:${packages[0].id}`;
					await loadPage(selected, false);
				}
			} catch {
				loadError = true;
			}
		})();
	});
</script>

<div class="browser">
	<aside class="tree-panel">
		<div class="panel-title">{t('tree.title')}</div>
		<nav class="tree">
			{#if treeLoading}
				<div class="hint">{t('table.loading')}</div>
			{:else if forest.length === 0}
				<div class="hint">{loadError ? t('error.load') : t('tree.empty')}</div>
			{:else}
				{#each forest as node (node.key)}
					<TreeView {node} {selected} onselect={select} />
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
				<a class="btn" href={`/p/${encodeURIComponent(currentPkgId)}/download`}>
					{t('action.downloadPackage')}
				</a>
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
				<button class="btn" onclick={() => void loadPage(selected, true)}>
					{t('table.loadMore')}（{files.length}/{total}）
				</button>
			</div>
		{/if}
	</section>
</div>

<style>
	.browser {
		height: 100%;
		display: grid;
		grid-template-columns: 280px 1fr;
		gap: 10px;
		padding: 10px;
	}

	.tree-panel,
	.files-panel {
		min-height: 0; /* grid 子项内部滚动 */
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.panel-title {
		flex: none;
		padding: 10px 14px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 1px;
		color: var(--text-faint);
		border-bottom: 1px solid var(--bg-l3);
	}

	.tree {
		flex: 1;
		overflow: auto;
		padding: 6px;
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
	}

	/* 面板头：面包屑 + 整包下载 */
	.files-head {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--bg-l3);
		min-height: 44px;
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

	.btn {
		flex: none;
		padding: 5px 14px;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--text);
		font-size: 13px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
		white-space: nowrap;
	}
	.btn:hover {
		background: var(--accent-deep);
		border-color: var(--accent-deep);
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
		border-top: 1px solid var(--bg-l3);
	}
</style>
