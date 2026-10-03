<script lang="ts">
	// 主页：左树（顶层 = 各包 → 包内文件夹层级）+ 右表（当前选中文件夹的文件）
	// 数据全部客户端运行时拉取（shell 预渲染只烘壳，不烘数据——config 依赖部署期环境变量，
	// 树数据需随库更新）；播放走共享 player（$lib/player.svelte.ts，与组装面板同一 Audio）。
	// 整包下载 = 按当前内容实时拼 zip（服务端拼包受免费计划 50 子请求限制不可行）：
	// 拉清单 → 并发直连 R2 拉去重 blob → fflate 流式 STORE 打包 → 保存（$lib/zip-save）
	import { onMount } from 'svelte';
	import TreeView from '$lib/components/TreeView.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import KitBuilder from '$lib/components/KitBuilder.svelte';
	import MoveDialog, { type MoveMode } from '$lib/components/MoveDialog.svelte';
	import {
		fetchTree,
		fetchFiles,
		fetchMe,
		fetchZipManifest,
		buildForest,
		parseNodeKey,
		canManage,
		renamePackage,
		renameFolder,
		renameFile,
		deletePackage,
		deleteFolder,
		deleteFiles,
		moveFiles,
		moveFolder,
		RenameConflictError,
		type RenameResult,
		type TreePackage,
		type Me
	} from '$lib/api';
	import { player } from '$lib/player.svelte';
	import { saveZip } from '$lib/zip-save';
	import { fetchIssuedUrl, absoluteApiUrl } from '$lib/api-base.svelte';
	import { t } from '$lib/i18n';
	import type { FileRow, TreeNode } from '$lib/types';
	import { selection, assignSelection } from '$lib/selection.svelte';
	import { cellForKey, kit } from '$lib/kit.svelte';
	import { ui } from '$lib/ui.svelte';

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
	let treeOpen = $state(false); // 窄屏目录抽屉开关（宽屏下 CSS 固定显示，此标志无视觉影响）

	const PAGE_SIZE = 200;

	// 整包下载状态机：idle / packing（x/y）/ error
	let dlState = $state<'idle' | 'packing' | 'error'>('idle');
	let dlDone = $state(0);
	let dlTotal = $state(0);

	// 播放器状态在共享 player 上（$state 由 Player 类内部管理）

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
	// 「删除所选」可见性：管理员任意，否则须是当前包主（跨包选中的他人文件服务端仍会 403）
	const canDeleteSel = $derived(
		canManage(me, packages.find((x) => x.id === currentPkgId)?.uploaderOsuId ?? null)
	);
	let selDeleting = $state(false); // 批量删除进行中（防连点）
	// 移动对话框：files = 多选所选，folder = 树小类（来源包 + 全路径）；null = 关闭
	let moveState = $state<MoveMode | null>(null);

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
				ui.pageReady = true; // 树 + 首页文件就绪 → 新手引导可启动（库为空不引导）
			}
		} catch {
			treeError = true;
		}
	}

	function select(key: string): void {
		treeOpen = false; // 窄屏抽屉选中即关
		if (key === selected) return;
		selected = key;
		void loadPage(key, false);
	}

	/** 整包下载：清单 → saveZip（同 hash 只拉一次，流式 STORE 打包，File System Access 优先） */
	async function downloadPackage(): Promise<void> {
		const pkgId = currentPkgId;
		if (!pkgId || dlState === 'packing') return;
		dlState = 'packing';
		dlDone = 0;
		try {
			const manifest = await fetchZipManifest(pkgId);
			dlTotal = manifest.files.length;
			await saveZip(manifest.name || 'package', {
				entries: manifest.files.map((f) => ({ path: f.path, key: f.hash })),
				load: async (hash) => {
					// 清单 urls 可为 R2 预签名绝对 URL 或 API 域绝对/相对回退 URL，三支分派见 api-base
					const r = await fetchIssuedUrl(manifest.urls[hash]);
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return new Uint8Array(await r.arrayBuffer());
				},
				concurrency: 6, // 6 路并发，兼顾速度与 R2/代理压力
				onProgress: (done, total) => {
					dlDone = done;
					dlTotal = total;
				}
			});
			dlState = 'idle'; // 'cancelled' 也不算失败
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
	 * 包改名撞名（409 name_taken，body 带将吸收它的最老同名包 id）→ confirm 后带
	 * merge=true 重提交：合并成功清掉被去重文件、选中迁到目标包对应层级；用户取消
	 * 合并则静默关闭编辑态（不走红框）。成功后强刷树；文件夹改名重映射选中 key
	 */
	async function submitRename(key: string, newName: string): Promise<boolean> {
		const { pkg, folder } = parseNodeKey(key);
		const name = newName.trim();
		if (!pkg || !name || name.includes('/') || name.includes('\\')) return false;
		// 改后的文件夹全路径（末级替换）
		const slash = folder.lastIndexOf('/');
		const newFolder = folder === '' ? name : slash === -1 ? name : `${folder.slice(0, slash)}/${name}`;

		if (folder !== '') {
			try {
				await renameFolder(pkg, folder, newFolder);
			} catch {
				return false;
			}
			const prev = selected;
			await refreshTree();
			const oldKey = `pkg:${pkg}/${folder}`;
			if (prev === oldKey || prev.startsWith(`${oldKey}/`)) {
				selected = `pkg:${pkg}/${newFolder}${prev.slice(oldKey.length)}`;
				void loadPage(selected, false);
			}
			return true;
		}

		// 包改名：撞同名 → 询问并入最老同名包（无他包同名时改名本身无害）
		let res: RenameResult;
		let mergedTargetId = '';
		try {
			res = await renamePackage(pkg, name);
		} catch (e) {
			if (!(e instanceof RenameConflictError)) return false;
			const target = packages.find((x) => x.id === e.targetId);
			if (!target) return false; // 树里找不到合并去向（树过期等）：无法确认，按失败保持编辑态
			const ownerHint = target.uploaderUsername
				? `（${t('file.owner')}：${target.uploaderUsername}）`
				: '';
			if (!window.confirm(t('pkg.confirmMerge', { name: target.name, ownerHint }))) {
				return true; // 用户放弃合并 = 放弃改名：正常关闭编辑态
			}
			try {
				res = await renamePackage(pkg, name, true);
				mergedTargetId = res.targetId ?? '';
			} catch (e2) {
				if (e2 instanceof Error) {
					if (e2.message === 'merge_target_invalid') window.alert(t('pkg.mergeTargetInvalid'));
					else if (e2.message === 'merge_target_gone') window.alert(t('pkg.mergeGone'));
					// 重试窗口内目标包易主（或上传者非本人且非管理员）：专属文案，不落通用红框
					else if (e2.message === 'merge_target_forbidden') window.alert(t('pkg.mergeTargetForbidden'));
				}
				return false;
			}
		}
		if (res.deduped?.length) kit.removeByFileIds(new Set(res.deduped));
		await refreshTree();
		// 合并成功：本包已删，选中落在其子树则迁到目标包对应层级
		const srcKey = `pkg:${pkg}`;
		if (
			mergedTargetId &&
			(selected === srcKey || selected.startsWith(`${srcKey}/`))
		) {
			selected = `pkg:${mergedTargetId}${selected.slice(srcKey.length)}`;
			void loadPage(selected, false);
		}
		return true;
	}

	/**
	 * 树节点删除（大类 = 整包；小类 = 该文件夹及子文件夹全部文件）。
	 * 删除后清选中集（其中可能有已删文件），并修正落在被删子树里的 selected。
	 */
	async function deleteNode(node: TreeNode): Promise<void> {
		const { pkg, folder } = parseNodeKey(node.key);
		const p = packages.find((x) => x.id === pkg);
		if (!p) return;
		const isPkg = folder === '';
		const name = isPkg ? p.name : node.name;
		if (!window.confirm(t(isPkg ? 'pkg.confirmDelete' : 'folder.confirmDelete', { name }))) {
			return;
		}
		try {
			if (isPkg) await deletePackage(pkg);
			else await deleteFolder(pkg, folder);
		} catch {
			window.alert(t('delete.failed'));
			return;
		}
		selection.clear();
		const deadKey = node.key;
		await refreshTree();
		// 当前选中落在被删节点（或其子树）里：包删（或文件夹删恰好删空整包）→ 清空；
		// 否则回包根
		if (selected === deadKey || selected.startsWith(`${deadKey}/`)) {
			if (isPkg || !packages.some((x) => x.id === pkg)) {
				selected = '';
				files = [];
				total = 0;
			} else {
				selected = `pkg:${pkg}`;
				void loadPage(selected, false);
			}
		}
	}

	/** 删除选中集里的全部文件（可跨包；权限服务端逐包校验；>450 分多次请求） */
	async function deleteSelected(): Promise<void> {
		if (selDeleting || selection.size === 0) return;
		const ids = selection.items.map((i) => i.id);
		if (!window.confirm(t('files.confirmDelete', { count: ids.length }))) return;
		selDeleting = true;
		try {
			// 服务端单次上限 500，留余量按 450 分片
			for (let i = 0; i < ids.length; i += 450) {
				await deleteFiles(ids.slice(i, i + 450));
			}
		} catch {
			selDeleting = false;
			window.alert(t('delete.failed'));
			void loadPage(selected, false); // 分片中途失败：已删部分同步回来
			void refreshTree();
			return;
		}
		const gone = new Set(ids);
		const removedHere = files.filter((f) => gone.has(f.id)).length;
		files = files.filter((f) => !gone.has(f.id));
		total = Math.max(0, total - removedHere);
		selection.items = selection.items.filter((i) => !gone.has(i.id));
		kit.removeByFileIds(gone); // 组装格子里引用的已删文件一并清掉（否则打包时 404）
		selDeleting = false;
		if (files.length === 0) void loadPage(selected, false); // 当前页删空：重载校正
		void refreshTree(); // 文件夹可能已空 → 树刷新
	}

	/** 树小类「移动」钮：解析节点 key 得来源（包 + 小类全路径），打开移动对话框 */
	function moveFolderNode(node: TreeNode): void {
		const { pkg, folder } = parseNodeKey(node.key);
		if (!pkg || !folder) return;
		moveState = { kind: 'folder', pkgId: pkg, folderPath: folder };
	}

	/**
	 * 移动对话框提交（分片与后续同步归页面层）：文件模式按 450 分片（服务端单次
	 * ≤500，与删除所选同款），合并各片被去重丢弃的 id。成功清组装格子引用、
	 * 同步多选（文件模式清空；小类模式仅剔除被去重死 id）、刷树并把落在被移
	 * 子树里的选中迁到目标位置；失败提示后返回 false 保持对话框开（数据未变更，不强刷）
	 */
	async function doMove(to: { pkgId: string; folderPath: string }): Promise<boolean> {
		const from = moveState;
		if (!from) return false;
		const deduped = new Set<string>();
		try {
			if (from.kind === 'files') {
				const ids = selection.items.map((i) => i.id);
				for (let i = 0; i < ids.length; i += 450) {
					const r = await moveFiles(ids.slice(i, i + 450), to.pkgId, to.folderPath);
					for (const d of r.deduped ?? []) deduped.add(d);
				}
			} else {
				const r = await moveFolder(from.pkgId, from.folderPath, to.pkgId, to.folderPath);
				for (const d of r.deduped ?? []) deduped.add(d);
			}
		} catch {
			window.alert(t('move.failed'));
			return false;
		}
		kit.removeByFileIds(deduped); // 目标已有同内容文件 → 被去重丢弃的 id 从组装格子清掉
		const movedSubtree =
			from.kind === 'folder' ? `pkg:${from.pkgId}/${from.folderPath}` : '';
		if (from.kind === 'files') selection.clear();
		// 小类模式：多选不清空（其中可有别处文件），只剔除被去重丢弃的死 id（整值重赋值）
		else selection.items = selection.items.filter((i) => !deduped.has(i.id));
		await refreshTree();
		if (movedSubtree && (selected === movedSubtree || selected.startsWith(`${movedSubtree}/`))) {
			// 选中落在被移子树：按目标位置平移（保留子树内余部）
			selected =
				`pkg:${to.pkgId}${to.folderPath ? `/${to.folderPath}` : ''}` +
				selected.slice(movedSubtree.length);
		}
		void loadPage(selected, false);
		return true;
	}

	/**
	 * 单文件改名提交（文件级 owner / 管理员；权限服务端把关）。
	 * 成功后本地替换行名——不重拉列表（服务端按名排序，重拉会丢「加载更多」进度
	 * 与滚动位置，下次进文件夹自然新序）；选中集里的同名快照一并同步
	 */
	async function submitFileRename(file: FileRow, newName: string): Promise<boolean> {
		const name = newName.trim();
		if (!name || name.includes('/') || name.includes('\\')) return false;
		try {
			await renameFile(file.id, name);
		} catch {
			return false;
		}
		files = files.map((f) => (f.id === file.id ? { ...f, name } : f));
		selection.items = selection.items.map((i) => (i.id === file.id ? { ...i, name } : i));
		return true;
	}

	/** 点行：未播→播、播放中→暂停、暂停→继续（key = file.id；Audio.src 无法带 header，走 absoluteApiUrl） */
	function togglePlay(file: FileRow): void {
		player.toggle(file.id, absoluteApiUrl(`/f/${encodeURIComponent(file.id)}`), file.durationS ?? undefined);
	}

	/** 点波形：当前行直接跳；别的行先播、metadata 就绪后再跳 */
	function seek(file: FileRow, ratio: number): void {
		player.seek(file.id, absoluteApiUrl(`/f/${encodeURIComponent(file.id)}`), ratio, file.durationS ?? undefined);
	}

	onMount(() => {
		// 初始加载树并默认选中第一个包（失败可经树面板重试按钮重走本流程）
		void initTree();
		// 登录态：树节点改名按钮的显示判定（失败按未登录处理）
		void fetchMe().then((m) => (me = m));

		// 全局键：Esc 清多选（无模态且不在输入中时）；格子快捷键把选中文件放入对应格子
		// （cellForKey 内部已处理修饰键/输入框/模态判定；对话框与引导浮层都带 aria-modal）
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (document.querySelector('[aria-modal="true"]')) return;
				const tgt = e.target as HTMLElement | null;
				if (tgt?.closest('input, textarea, select, [contenteditable="true"]')) return;
				if (selection.size > 0) selection.clear();
				return;
			}
			const cell = cellForKey(e);
			if (cell && selection.size > 0) {
				e.preventDefault();
				assignSelection(cell);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="browser">
	<aside class="tree-panel" class:open={treeOpen} data-tour="tree">
		<div class="panel-title"><span>{t('tree.title')}</span></div>
		<nav class="tree">
			{#if treeLoading}
				<!-- 加载中占位骨架（透明度脉动，不位移） -->
				<div class="skel-list" aria-hidden="true">
					{#each [0, 1, 2, 3, 4, 5] as i (i)}
						<div class="skel skel-tree-row"></div>
					{/each}
				</div>
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
					ondelete={deleteNode}
					onmove={moveFolderNode}
				/>
			{/each}
			{/if}
		</nav>
	</aside>
	<!-- 窄屏抽屉遮罩（点击关抽屉；宽屏不渲染出视觉效果——抽屉不定位时遮罩也隐藏） -->
	{#if treeOpen}
		<div class="drawer-mask" onclick={() => (treeOpen = false)} aria-hidden="true"></div>
	{/if}

	<section class="files-panel">
		<div class="files-head">
			<button
				class="btn drawer-btn"
				aria-expanded={treeOpen}
				onclick={() => (treeOpen = !treeOpen)}
			>
				{t('tree.drawer')}
			</button>
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
					<button
						class="btn primary packing"
						disabled
						style:--pct={dlTotal > 0 ? (dlDone / dlTotal) * 100 : 0}
					>
						{t('download.packaging', { n: dlDone, total: dlTotal })}
					</button>
				{:else}
					<button
						class="btn primary"
						class:err={dlState === 'error'}
						data-tour="packdl"
						title={dlState === 'error' ? t('download.failedHint') : ''}
						onclick={() => void downloadPackage()}
					>
						{dlState === 'error' ? t('download.failedRetry') : t('action.downloadPackage')}
					</button>
				{/if}
			{/if}
		</div>

		<!-- 多选条：有选中时显示；按格子快捷键或点组装格子批量入格（选中跨文件夹保留） -->
		{#if selection.size > 0}
			<div class="selbar" role="status">
				<span class="selbar-text">{t('sel.bar', { count: selection.size })}</span>
				<span class="selbar-btns">
					{#if canDeleteSel}
						<button class="btn" disabled={selDeleting} onclick={() => (moveState = { kind: 'files' })}>
							{t('sel.move')}
						</button>
						<button
							class="btn danger"
							disabled={selDeleting}
							onclick={() => void deleteSelected()}
						>
							{t('sel.delete')}
						</button>
					{/if}
					<button class="btn" onclick={() => selection.clear()}>{t('sel.clear')}</button>
				</span>
			</div>
		{/if}

		<div class="files-body" data-tour="files">
			{#if loading}
				<!-- 文件表加载占位骨架 -->
				<div class="skel-files" aria-hidden="true">
					{#each [0, 1, 2, 3, 4, 5, 6, 7] as i (i)}
						<div class="skel skel-file-row"></div>
					{/each}
				</div>
			{:else if loadError}
				<div class="hint">
					{t('error.load')}
					<button class="retry" onclick={() => void loadPage(selected, false)}>{t('action.retry')}</button>
				</div>
			{:else}
				<FileTable
					{files}
					playingId={player.current}
					paused={player.paused}
					progress={player.progress}
					{me}
					onplay={togglePlay}
					onseek={seek}
					onrename={submitFileRename}
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

	<!-- 移动对话框：目标选择壳，接口调用与后续同步在 doMove -->
	{#if moveState}
		<MoveDialog
			mode={moveState}
			{packages}
			{me}
			onclose={() => (moveState = null)}
			onsubmit={doMove}
		/>
	{/if}
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

	/* 按钮基元在 app.css（.btn/.primary/.err/.packing）；这里只留骨架布局 */

	/* 树/文件表加载骨架：长短不一的行列（仅透明度脉动） */
	.skel-list {
		padding: 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.skel-tree-row {
		height: 14px;
		width: 72%;
	}
	.skel-tree-row:nth-child(2n) {
		width: 48%;
		margin-left: 16px;
	}
	.skel-files {
		padding: 14px 12px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.skel-file-row {
		height: 30px;
	}
	.skel-file-row:nth-child(2n) {
		width: 88%;
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

	/* 多选条：薄荷浅底提示 + 清除 */
	.selbar {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 12px;
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-l2));
		border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
	}
	.selbar-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--accent-bright);
	}
	.selbar-btns {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* 目录抽屉开关：仅窄屏显示 */
	.drawer-btn {
		display: none;
		flex: none;
	}
	.drawer-mask {
		display: none;
	}

	/* ============ 窄屏（≤768px）：单栏 + 目录抽屉 ============ */
	@media (max-width: 768px) {
		.browser {
			grid-template-columns: 1fr;
			padding: 10px;
			gap: 10px;
			overflow: hidden; /* 防横向溢出（360–430px） */
		}

		.tree-panel {
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			width: min(300px, 82vw);
			z-index: 80;
			border-radius: 0;
			border-left: none;
			transform: translateX(-105%);
			transition: transform 0.25s ease;
		}
		.tree-panel.open {
			transform: none;
		}
		.drawer-mask {
			display: block;
			position: fixed;
			inset: 0;
			z-index: 70;
			background: rgb(9 12 9 / 0.55);
		}
		.drawer-btn {
			display: inline-flex;
		}

		.files-head {
			gap: 8px;
			padding: 6px 8px;
		}
		.crumbs {
			flex: 1;
			min-width: 0;
			overflow-x: auto;
			flex-wrap: nowrap;
		}
		.selbar {
			padding: 6px 8px;
		}
	}

	/* 降低动态：抽屉滑动也尊重系统设置 */
	@media (prefers-reduced-motion: reduce) {
		.tree-panel {
			transition: none;
		}
	}
</style>
