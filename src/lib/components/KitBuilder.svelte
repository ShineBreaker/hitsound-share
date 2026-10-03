<script lang="ts">
	// 自定义音效组悬浮面板（命名 <行>-<列><序号>.<格式>，如 drum-hitnormal2.wav）：
	// 收起态 = 右下角悬浮钮（GitHub 反馈钮旁），展开态 = 右下角浮层面板；
	// 文件表行可拖入格子（DND_FILE_MIME 自定义类型，拖起时面板自动展开）；
	// 选中文件后点格子 / 按 Q–Y、A–H、Z–N 也可批量入格（assignSelection）；
	// 「打包下载」按当前格子内容实时拉 /f/<id> 全量（同 id 去重）→ fflate 流式 STORE 拼 zip → 保存（$lib/zip-save）
	// 格子内容/序号规则/键位映射/开面态都在 $lib/kit.svelte.ts（kit 单例），本组件只管渲染与事件接线
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { DND_FILE_MIME, type KitDragData } from '$lib/api';
	import { apiFetch, absoluteApiUrl } from '$lib/api-base.svelte';
	import {
		kit,
		kitTarget,
		KIT_ROWS,
		KIT_COLS,
		CELL_LETTERS,
		type CellKey,
		type KitRow,
		type KitCol,
		type KitItem
	} from '$lib/kit.svelte';
	import { osz, OszError, type OszEntry } from '$lib/osz.svelte';
	import { cad } from '$lib/cad.svelte';
	import CadPreview from '$lib/components/CadPreview.svelte';
	import { loadUnrarWasm } from '$lib/unrar-wasm';
	import { load7zWasm } from '$lib/seven-zip-wasm';
	import { selection, assignSelection } from '$lib/selection.svelte';
	import { player } from '$lib/player.svelte';
	import { saveZip } from '$lib/zip-save';

	let overKey = $state(''); // 拖拽悬停中的格子 key（高亮）

	// 预览播放：与文件表共用同一 Audio（key 前缀 'kit:'——全局同一时刻只有一路播放）
	const playingUid = $derived(
		player.current?.startsWith('kit:') ? Number(player.current.slice(4)) : -1
	);
	const playingPaused = $derived(player.paused);

	// 打包状态机：idle / packing（x/y）/ error（按钮变红，点击重试）
	let dlState = $state<'idle' | 'packing' | 'error'>('idle');
	let dlDone = $state(0);
	let dlTotal = $state(0);

	// —— 谱面集（osz）：导入 → 覆盖预览（琥珀框 = 将被替换的根目录音效）→ 合并导出 ——
	let oszInput = $state<HTMLInputElement | undefined>();
	let oszErr = $state(''); // 导入失败文案键（osz.err.*）
	let oszListOpen = $state(true); // 谱面内容列表展开态
	let oszOver = $state(false); // 系统文件拖入悬停中
	let ezState = $state<'idle' | 'packing' | 'error'>('idle'); // 导出状态机
	let ezDone = $state(0);
	let ezTotal = $state(0);

	// 覆盖计划：格子项命中谱面集根目录同 stem 音频即顶替（$lib/osz.svelte.ts）
	const overlays = $derived(osz.overlays(kit.entries));
	// chip 黄框：会替换掉谱面集音效的格子项（uid → 首个被替换 path，tooltip 用）
	const repUids = $derived(new Set(overlays.filter((o) => o.hits.length > 0).map((o) => o.uid)));
	const repTip = $derived(
		new Map(overlays.filter((o) => o.hits.length > 0).map((o) => [o.uid, o.hits[0]]))
	);
	// 谱面集列表黄框：被替换的根目录音频 path → 新文件名
	const replacedBy = $derived.by(() => {
		const m = new Map<string, string>();
		for (const o of overlays) for (const h of o.hits) m.set(h, o.target);
		return m;
	});

	// 谱面集音频试听：key 前缀 'osz:'（与文件表/格子共用同一 Audio，互斥播放）
	const playingOsz = $derived(
		player.current?.startsWith('osz:') ? player.current.slice(4) : ''
	);

	function allowDrop(e: DragEvent, key: string): void {
		if (!e.dataTransfer?.types.includes(DND_FILE_MIME)) return;
		e.preventDefault(); // 必须 preventDefault 才触发 drop
		e.dataTransfer.dropEffect = 'copy';
		overKey = key;
	}

	function leaveCell(e: DragEvent, key: string): void {
		// 移入格子内子元素也触发 dragleave：只在真正离开格子时清高亮
		if (
			overKey === key &&
			!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)
		) {
			overKey = '';
		}
	}

	/** 落格：payload = {files}；多文件走续号规则（addNumbered），单文件无序号（add） */
	function drop(e: DragEvent, key: string): void {
		if (!e.dataTransfer?.types.includes(DND_FILE_MIME)) return;
		e.preventDefault();
		overKey = '';
		try {
			const data = JSON.parse(e.dataTransfer.getData(DND_FILE_MIME)) as KitDragData;
			if (!Array.isArray(data.files) || data.files.length === 0) return;
			if (data.files.length === 1) kit.add(key, data.files[0]);
			else kit.addNumbered(key, data.files);
		} catch {
			/* 非文件表拖来的数据，忽略 */
		}
	}

	/** 点格子：有多选则批量入格；点在 chip 控件上不算（那是播放/删除/序号编辑） */
	function clickCell(e: MouseEvent, key: CellKey): void {
		if (selection.size === 0) return;
		if ((e.target as Element | null)?.closest?.('.chip')) return;
		assignSelection(key);
	}

	/** `${row}/${col}` 类型收窄到 CellKey（行列都来自常量表，组合必然合法） */
	function cellKey(row: KitRow, col: KitCol): CellKey {
		return `${row}/${col}`;
	}

	function removeItem(key: string, it: KitItem): void {
		// 只停自己的 key（文件表正在播放时不打扰）
		if (player.current === `kit:${it.uid}`) player.stop();
		kit.remove(key, it.uid);
	}

	function clearAll(): void {
		if (playingUid !== -1) player.stop(); // 同上：仅当当前 key 属于本面板
		kit.clear();
	}

	/** 点 chip 播放钮：未播→播、播放中→暂停、暂停→继续（同文件表交互；Audio.src 走 absoluteApiUrl 带 token query） */
	function togglePlay(it: KitItem): void {
		player.toggle(`kit:${it.uid}`, absoluteApiUrl(`/f/${encodeURIComponent(it.id)}`));
	}

	/** 格子项音源：fetch 不带 Range → 200 全量（kit zip 与 osz 导出共用） */
	async function loadFileBytes(id: string): Promise<Uint8Array> {
		const r = await apiFetch(`/f/${encodeURIComponent(id)}`);
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		return new Uint8Array(await r.arrayBuffer());
	}

	/** 打包下载：并发拉取（同 id 去重）→ 流式 STORE 写入 → 落盘（同整包下载策略） */
	async function downloadZip(): Promise<void> {
		if (dlState === 'packing' || kit.entries.length === 0) return;
		dlState = 'packing';
		dlDone = 0;
		dlTotal = kit.entries.length;
		try {
			await saveZip(t('kit.zipName'), {
				entries: kit.entries.map((e) => ({ path: e.target, key: e.id })),
				load: loadFileBytes,
				concurrency: 6,
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

	/** 导入谱面集（按钮选择 / 系统文件拖入共用入口）；成败都展开面板露出谱面集栏 */
	async function importOszFile(f: File): Promise<void> {
		oszErr = '';
		try {
			await osz.importFile(
				{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) },
				{ loadWasm: { unrar: loadUnrarWasm, sz: load7zWasm } }
			);
			oszListOpen = true;
		} catch (e) {
			oszErr = e instanceof OszError ? e.code : 'corrupt';
		}
		kit.open = true;
	}

	function onOszChosen(e: Event): void {
		const el = e.currentTarget as HTMLInputElement;
		const f = el.files?.[0];
		if (f) void importOszFile(f);
		el.value = ''; // 允许再次选同一文件
	}

	function removeOsz(): void {
		if (player.current?.startsWith('osz:')) player.stop(); // 只停自己的 key
		cad.close(); // 谱面集没了，预览窗一并关掉
		osz.clear();
		oszErr = '';
	}

	/** 导出合并 .osz：谱面集原条目剔除被替换者 + 格子项写包根（osz.packArgs → saveZip） */
	async function exportOsz(): Promise<void> {
		if (ezState === 'packing' || !osz.loaded) return;
		ezState = 'packing';
		ezDone = 0;
		try {
			const args = osz.packArgs(kit.entries, loadFileBytes);
			ezTotal = args.entries.length;
			await saveZip(osz.exportName, {
				...args,
				ext: 'osz',
				onProgress: (done, total) => {
					ezDone = done;
					ezTotal = total;
				}
			});
			ezState = 'idle';
		} catch {
			ezState = 'error';
		}
	}

	/** 谱面集音频试听（共享 player，blob URL 由 osz 模块缓存回收） */
	function toggleOszPlay(e: OszEntry): void {
		player.toggle(`osz:${e.path}`, osz.audioUrl(e));
	}

	/** chip 提示：重名警示优先，其次是谱面集替换说明 */
	function chipTitle(target: string, uid: number): string {
		if (kit.dupTargets.has(target)) return `${target} — ${t('kit.dupName')}`;
		const rep = repTip.get(uid);
		if (rep) return `${target} — ${t('osz.willReplace', { name: rep })}`;
		return target;
	}

	// 系统文件拖入导入 osz：types 含 'Files' 才是 OS 拖入（行内 DND_FILE_MIME 不命中）
	function oszDragOver(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		oszOver = true;
	}

	function oszDragLeave(e: DragEvent): void {
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
			oszOver = false;
		}
	}

	function oszDrop(e: DragEvent): void {
		oszOver = false;
		const f = e.dataTransfer?.files?.[0];
		if (f) {
			e.preventDefault();
			void importOszFile(f);
		}
	}

	/** 导入失败的 i18n 文案（未知错误码回退 corrupt） */
	const oszErrText = $derived.by(() => {
		if (!oszErr) return '';
		const key = `osz.err.${oszErr}` as Parameters<typeof t>[0];
		const text = t(key);
		return text === key ? t('osz.err.corrupt') : text;
	});

	onMount(() => {
		// 拖起文件表行时自动展开面板（types 在 dragstart 阶段已可读，getData 不行）。
		// setTimeout 延迟到拖拽会话建立后再改 DOM：dragstart 事件内同步增删节点
		// 会让 Chromium 直接放弃本次拖拽（表现为第一次拖没反应、第二次才好）
		const onDragStart = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes(DND_FILE_MIME)) setTimeout(() => (kit.open = true), 0);
		};
		// 拖到一半取消（Esc / 释放在无效区）时清掉格子悬停高亮
		const onDragEnd = () => (overKey = '');
		window.addEventListener('dragstart', onDragStart);
		window.addEventListener('dragend', onDragEnd);
		return () => {
			window.removeEventListener('dragstart', onDragStart);
			window.removeEventListener('dragend', onDragEnd);
		};
	});
</script>

{#if !kit.open}
	<!-- 收起态：右下角悬浮钮（GitHub 反馈钮左侧），badge 显示已放音效数；也接受拖入 .osz 导入谱面集 -->
	<button
		class="kit-fab"
		class:over={oszOver}
		data-tour="kit"
		onclick={() => (kit.open = true)}
		title={t('kit.title')}
		aria-label={t('kit.title')}
		ondragover={oszDragOver}
		ondragleave={oszDragLeave}
		ondrop={oszDrop}
	>
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<rect x="1" y="1" width="6" height="6" rx="1.5" />
			<rect x="9" y="1" width="6" height="6" rx="1.5" />
			<rect x="1" y="9" width="6" height="6" rx="1.5" />
			<rect x="9" y="9" width="6" height="6" rx="1.5" />
		</svg>
		{#if kit.count > 0}
			<span class="fab-badge">{kit.count}</span>
		{/if}
	</button>
{:else}
	<div
		class="kit-panel"
		role="dialog"
		aria-label={t('kit.title')}
		ondragover={oszDragOver}
		ondragleave={oszDragLeave}
		ondrop={oszDrop}
	>
		<div class="kit-bar">
			<span class="kit-name">{t('kit.title')}</span>
			{#if kit.count > 0}
				<span class="badge">{t('kit.count', { count: kit.count })}</span>
			{/if}
			<span class="kit-hint" aria-live="polite">{kit.notice || t('kit.hint')}</span>
			<div class="kit-actions">
				<button class="btn" disabled={kit.count === 0} onclick={clearAll}>
					{t('kit.clear')}
				</button>
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
						disabled={kit.count === 0}
						title={dlState === 'error' ? t('download.failedHint') : ''}
						onclick={() => void downloadZip()}
					>
						{dlState === 'error' ? t('download.failedRetry') : t('kit.download')}
					</button>
				{/if}
				<button
					class="collapse"
					title={t('kit.collapse')}
					aria-label={t('kit.collapse')}
					onclick={() => (kit.open = false)}
				>
					×
				</button>
			</div>
		</div>

		<!-- 谱面集栏：导入 .osz / 展示命中统计与导出；琥珀框 = 将被替换的根目录音效 -->
		<div class="osz-bar" class:over={oszOver}>
			{#if !osz.loaded}
				<button class="btn osz-import" type="button" onclick={() => oszInput?.click()}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path
							d="M8 10.5V2.8M5.4 5.4 8 2.8l2.6 2.6M2.5 9.5V13a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 13.5 13V9.5"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					{t('osz.import')}
				</button>
				<span class="osz-hint" class:err-text={!!oszErr}>
					{oszErr ? oszErrText : t('osz.hint')}
				</span>
			{:else}
				<span class="osz-name" title={osz.name}>{osz.name}</span>
				<span class="badge">{t('osz.files', { count: osz.entries.length })}</span>
				{#if replacedBy.size > 0}
					<span class="badge amber">{t('osz.replacing', { count: replacedBy.size })}</span>
				{/if}
				<span class="osz-spacer"></span>
				<button
					class="osz-toggle"
					aria-expanded={oszListOpen}
					onclick={() => (oszListOpen = !oszListOpen)}
				>
					{t('osz.listToggle')}
					<span class="caret" aria-hidden="true">{oszListOpen ? '▾' : '▸'}</span>
				</button>
				<button
					class="btn"
					class:primary={cad.open}
					title={t('cad.previewHint')}
					onclick={() => (cad.open ? cad.close() : cad.openPreview())}
				>
					{t('cad.preview')}
				</button>
				{#if ezState === 'packing'}
					<button
						class="btn primary packing"
						disabled
						style:--pct={ezTotal > 0 ? (ezDone / ezTotal) * 100 : 0}
					>
						{t('download.packaging', { n: ezDone, total: ezTotal })}
					</button>
				{:else}
					<button
						class="btn primary"
						class:err={ezState === 'error'}
						title={ezState === 'error' ? t('download.failedHint') : ''}
						onclick={() => void exportOsz()}
					>
						{ezState === 'error' ? t('download.failedRetry') : t('osz.export')}
					</button>
				{/if}
				<button
					class="collapse"
					title={t('osz.remove')}
					aria-label={t('osz.remove')}
					onclick={removeOsz}
				>
					×
				</button>
			{/if}
		</div>
		{#if osz.loaded && oszListOpen}
			<div class="osz-list">
				{#each osz.audioEntries as e, i (i)}
					{@const rep = replacedBy.get(e.path)}
					<div class="osz-row" class:replaced={rep !== undefined}>
						<button
							class="play"
							onclick={() => toggleOszPlay(e)}
							aria-label={playingOsz === e.path && !playingPaused
								? t('action.pause')
								: t('action.play')}
						>
							{#if playingOsz === e.path && !playingPaused}
								<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
							{:else}
								▶
							{/if}
						</button>
						<span class="osz-path" title={e.path}>{e.path}</span>
						{#if rep !== undefined}
							<span class="rep-to" title={t('osz.willReplace', { name: rep })}>→ {rep}</span>
						{/if}
					</div>
				{/each}
				{#if osz.otherCount > 0}
					<div class="osz-foot">{t('osz.others', { count: osz.otherCount })}</div>
				{/if}
			</div>
		{/if}
		<input
			bind:this={oszInput}
			type="file"
			accept=".osz,.zip,.rar,.7z"
			class="vh"
			onchange={onOszChosen}
			aria-label={t('osz.import')}
		/>

		<div class="kit-grid">
			<div class="corner"></div>
			{#each KIT_COLS as col (col)}
				<div class="colhead">{col}</div>
			{/each}
			{#each KIT_ROWS as row (row)}
				<div class="rowhead">{row}</div>
				{#each KIT_COLS as col (col)}
					{@const key = cellKey(row, col)}
					<!-- 格子点击 = 多选入格的便捷路径；键盘等价物是格子快捷键（cellForKey），
					     div 无法用 button 替代（内部含可交互 chip） -->
					<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
					<div
						class="cell"
						class:over={overKey === key}
						class:cand={selection.size > 0}
						class:flash={kit.flashKey === key}
						role="list"
						aria-label={`${row}-${col}`}
						ondragover={(e) => allowDrop(e, key)}
						ondragleave={(e) => leaveCell(e, key)}
						ondrop={(e) => drop(e, key)}
						onclick={(e) => clickCell(e, key)}
					>
						{#each kit.cells[key] ?? [] as it (it.uid)}
							{@const target = kitTarget(row, col, it)}
							<div
								class="chip"
								role="listitem"
								class:dup={kit.dupTargets.has(target)}
								class:willrep={repUids.has(it.uid)}
								class:playing={playingUid === it.uid}
								title={chipTitle(target, it.uid)}
							>
								<button
									class="play"
									onclick={() => togglePlay(it)}
									aria-label={playingUid === it.uid && !playingPaused
										? t('action.pause')
										: t('action.play')}
								>
									{#if playingUid === it.uid && !playingPaused}
										<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
									{:else}
										▶
									{/if}
								</button>
								<span class="cname">{it.name}</span>
								<input
									class="suffix"
									value={it.suffix}
									inputmode="numeric"
									maxlength="3"
									placeholder="#"
									title={t('kit.suffix')}
									aria-label={t('kit.suffix')}
									oninput={(e) => {
										// 直接回写 DOM：清洗后与原值相同时 Svelte 不会刷新 input，残留非法字符
										const clean = e.currentTarget.value.replace(/\D/g, '');
										e.currentTarget.value = clean;
										kit.setSuffix(key, it.uid, clean);
									}}
								/>
								<button
									class="rm"
									title={t('kit.remove')}
									aria-label={t('kit.remove')}
									onclick={() => removeItem(key, it)}
								>
									×
								</button>
							</div>
						{:else}
							<span class="plus" aria-hidden="true">+</span>
						{/each}
						{#if selection.size > 0}
							<span class="keycap" aria-hidden="true">{CELL_LETTERS[key]}</span>
						{/if}
					</div>
				{/each}
			{/each}
		</div>
	</div>
{/if}

<!-- osu!cad 实时预览悬浮窗：与组装面板独立，格子改动经 cad 桥热更新进谱面播放器 -->
{#if cad.open}
	<CadPreview />
{/if}

<style>
	/* 收起态：右下角悬浮钮（GitHub 反馈钮 40px@right:16 的左侧 12px 处） */
	.kit-fab {
		position: fixed;
		right: 68px;
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		z-index: 50;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		border: none;
		background: var(--accent);
		color: var(--on-accent);
		cursor: pointer;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
		transition: background 0.15s ease;
	}
	.kit-fab:hover {
		background: var(--accent-bright);
	}
	.kit-fab svg {
		width: 18px;
		height: 18px;
		fill: currentColor;
	}

	.fab-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent-pink);
		border: 2px solid var(--bg-l1);
		color: var(--on-accent);
		font-size: 10px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* FAB 接受系统文件拖入（导入谱面集）时的悬停高亮 */
	.kit-fab.over {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* ===== 谱面集（osz）栏与内容列表 ===== */
	.osz-bar {
		flex: none;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 4px 12px;
		min-height: 36px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		background: color-mix(in srgb, var(--bg-inset) 55%, transparent);
		transition:
			background 0.15s ease,
			box-shadow 0.15s ease;
	}
	/* 系统文件拖入悬停：整条薄荷描边提示可落点 */
	.osz-bar.over {
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-inset));
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.osz-import {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 12px;
		font-size: 12px;
		border: 1px dashed color-mix(in srgb, var(--accent) 60%, transparent);
		color: var(--accent-bright);
	}
	.osz-import:hover {
		border-style: solid;
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, transparent);
		color: var(--accent-bright);
	}
	.osz-import svg {
		width: 13px;
		height: 13px;
	}

	.osz-hint {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
		font-size: 12px;
	}
	.osz-hint.err-text {
		color: var(--accent-pink);
	}

	.osz-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 600;
		color: var(--accent-bright);
	}

	.badge.amber {
		background: color-mix(in srgb, var(--accent-amber) 22%, transparent);
		color: var(--accent-amber);
	}

	.osz-spacer {
		flex: 1;
	}

	.osz-toggle {
		flex: none;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 12px;
		cursor: pointer;
		padding: 3px 8px;
		border-radius: var(--radius);
	}
	.osz-toggle:hover {
		color: var(--text);
		background: var(--bg-l3);
	}
	.osz-toggle .caret {
		font-size: 10px;
	}

	/* 谱面集音频列表：琥珀框 = 将被替换的根目录音效（同色 badge/提示一致口径） */
	.osz-list {
		flex: none;
		max-height: 136px;
		overflow-y: auto;
		padding: 6px 12px 8px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.osz-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 2px 6px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		font-size: 12px;
	}
	.osz-row.replaced {
		border-color: var(--accent-amber);
		background: color-mix(in srgb, var(--accent-amber) 10%, transparent);
	}

	.osz-path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-dim);
	}
	.osz-row.replaced .osz-path {
		text-decoration: line-through;
		text-decoration-color: color-mix(in srgb, var(--accent-amber) 70%, transparent);
	}

	.rep-to {
		flex: none;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--accent-amber);
		font-size: 11px;
		font-weight: 600;
	}

	.osz-foot {
		padding: 3px 6px 0;
		color: var(--text-faint);
		font-size: 11px;
	}

	/* 隐藏但可激活的文件输入（label/按钮触发） */
	.vh {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* 展开态：右下角浮层（z-index 低于对话框 100、高于内容） */
	.kit-panel {
		position: fixed;
		right: 16px;
		bottom: calc(68px + env(safe-area-inset-bottom, 0px));
		z-index: 60;
		width: min(980px, calc(100vw - 32px));
		max-height: min(430px, calc(100vh - 150px));
		display: flex;
		flex-direction: column;
		background: var(--bg-l2);
		border: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
		overflow: hidden;
	}

	.kit-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 12px;
		min-height: 42px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
	}

	.kit-name {
		flex: none;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.badge {
		flex: none;
		padding: 0 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 25%, transparent);
		color: var(--accent-bright);
		font-size: 11px;
	}

	.kit-hint {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
		font-size: 12px;
	}

	.kit-actions {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.collapse {
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: var(--radius);
	}
	.collapse:hover {
		color: var(--text);
		background: var(--bg-l3);
	}

	/* 按钮基元在 app.css；面板动作区比正文按钮略小一号 */
	.kit-actions .btn {
		padding: 4px 14px;
		font-size: 12px;
	}

	.kit-grid {
		display: grid;
		grid-template-columns: 64px repeat(6, minmax(100px, 1fr));
		grid-template-rows: auto repeat(3, minmax(66px, auto));
		gap: 6px;
		padding: 8px 12px 12px;
		flex: 1;
		min-height: 0;
		overflow: auto;
	}

	.colhead {
		text-align: center;
		color: var(--text-dim);
		font-size: 12px;
		font-weight: 600;
		padding-bottom: 2px;
	}

	.rowhead {
		align-self: center;
		text-align: right;
		padding-right: 8px;
		color: var(--text-dim);
		font-size: 13px;
	}

	/* 格子：编辑器音效格同款浮起方格 + 居中 + */
	.cell {
		position: relative;
		min-width: 0;
		background: var(--bg-l3);
		border: 1px solid transparent;
		border-radius: 8px;
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow-y: auto;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.cell.over {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-l3));
	}
	/* 悬停高亮改变子元素（+号变色）时 Chromium 会在 cell/plus 间抖动命中目标，
	   可能吞 drop；格子悬停时子元素一律不接收指针事件 */
	.cell.over > *,
	.plus {
		pointer-events: none;
	}
	/* 有多选待入格：所有格子虚线薄荷描边提示可点 */
	.cell.cand {
		border: 1px dashed color-mix(in srgb, var(--accent) 65%, transparent);
		cursor: copy;
	}
	.cell.cand:hover {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-l3));
	}
	/* 入格反馈：短暂薄荷高亮（仅颜色过渡，无位移） */
	.cell.flash {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 22%, var(--bg-l3));
	}

	/* 多选时格角键帽字母：快捷键只在键鼠（可悬停+精指针）设备有意义，
	   触屏入格走点格子路径，不显示以免误导 */
	.keycap {
		position: absolute;
		top: 3px;
		right: 3px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		display: none;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		background: var(--bg-inset);
		border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent-bright);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		pointer-events: none;
	}
	@media (hover: hover) and (pointer: fine) {
		.keycap {
			display: inline-flex;
		}
	}

	.plus {
		margin: auto;
		color: var(--text-faint);
		font-size: 20px;
		line-height: 1;
		user-select: none;
	}
	.cell.over .plus {
		color: var(--accent-bright);
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 2px 4px;
		border-radius: var(--radius);
		background: var(--bg-l2);
		font-size: 12px;
	}
	.chip.willrep {
		outline: 1px solid var(--accent-amber);
	}
	.chip.dup {
		outline: 1px solid var(--accent-pink);
	}
	.chip.playing {
		outline: 1px solid var(--accent);
	}

	.play {
		flex: none;
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--accent-bright);
		font-size: 9px;
		cursor: pointer;
		border-radius: var(--radius);
		padding: 0;
	}
	.play:hover {
		background: var(--bg-l3);
	}

	.cname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}

	.suffix {
		flex: none;
		width: 26px;
		padding: 1px 3px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--accent-bright);
		font-size: 11px;
		text-align: center;
		font-family: inherit;
	}
	.suffix:focus {
		outline: none;
		border-color: var(--accent);
	}

	.rm {
		flex: none;
		width: 18px;
		height: 18px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
		border-radius: var(--radius);
		padding: 0;
	}
	.rm:hover {
		color: var(--accent-pink);
		background: var(--bg-l3);
	}

	/* 播放指示：三根跳动条（FileTable 同款缩小版） */
	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 1.5px;
		height: 10px;
	}
	.eq i {
		width: 2px;
		background: var(--accent-pink);
		animation: eq 0.9s infinite ease-in-out alternate;
	}
	.eq i:nth-child(1) {
		height: 60%;
		animation-delay: -0.3s;
	}
	.eq i:nth-child(2) {
		height: 100%;
	}
	.eq i:nth-child(3) {
		height: 40%;
		animation-delay: -0.6s;
	}
	@keyframes eq {
		from {
			transform: scaleY(0.4);
		}
		to {
			transform: scaleY(1);
		}
	}

	/* 窄屏：底栏全宽 sheet；格子区保持自然宽度横向滚动；提示语让位 */
	@media (max-width: 768px) {
		.kit-panel {
			left: 0;
			right: 0;
			bottom: 0;
			width: 100%;
			max-height: 60vh;
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			border-bottom: none;
		}
		.kit-hint,
		.osz-hint {
			display: none;
		}
		.kit-grid {
			grid-template-columns: 44px repeat(6, minmax(104px, 130px));
		}
	}

	/* 超窄屏（≤480）：6 列全部挤进视口、格子区不再横向滚动；
	   chip 改两行网格，播放/序号/×都保 ≥28px 触点，名字让位省略号 */
	@media (max-width: 480px) {
		.kit-grid {
			grid-template-columns: 44px repeat(6, minmax(0, 1fr));
			grid-template-rows: auto repeat(3, minmax(62px, auto));
			gap: 4px;
			padding: 6px 8px 10px;
		}
		.colhead {
			font-size: 10px;
			overflow-wrap: anywhere;
		}
		.rowhead {
			font-size: 10px;
			padding-right: 4px;
		}
		.cell {
			padding: 3px;
			gap: 2px;
			border-radius: 6px;
		}
		.chip {
			display: grid;
			grid-template-columns: 28px minmax(0, 1fr) 28px;
			grid-template-areas:
				'name name rm'
				'play suf suf';
			gap: 2px;
			padding: 2px;
			font-size: 11px;
		}
		.cname {
			grid-area: name;
		}
		.play {
			grid-area: play;
			width: 28px;
			height: 28px;
		}
		.rm {
			grid-area: rm;
			width: 28px;
			height: 28px;
		}
		.suffix {
			grid-area: suf;
			width: auto;
			height: 28px;
			padding: 1px 4px;
		}
	}
</style>
