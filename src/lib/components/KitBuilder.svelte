<script lang="ts">
	// 自定义音效组悬浮面板（命名 <行>-<列><序号>.<格式>，如 drum-hitnormal2.wav）：
	// 收起态 = 右下角悬浮钮（GitHub 反馈钮旁），展开态 = 右下角浮层面板；
	// 文件表行可拖入格子（DND_FILE_MIME 自定义类型，拖起时面板自动展开）；
	// 选中文件后点格子 / 按 Q–V 也可批量入格（assignSelection）；
	// 「打包下载」按当前格子内容实时拉 /f/<id> 全量（同 id 去重）→ fflate 流式 STORE 拼 zip → 保存（$lib/zip-save）
	// 格子内容/序号规则/键位映射/开面态都在 $lib/kit.svelte.ts（kit 单例），本组件只管渲染与事件接线
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { DND_FILE_MIME, type KitDragData } from '$lib/api';
	import {
		kit,
		KIT_ROWS,
		KIT_COLS,
		CELL_LETTERS,
		type CellKey,
		type KitRow,
		type KitCol,
		type KitItem
	} from '$lib/kit.svelte';
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

	/** 点 chip 播放钮：未播→播、播放中→暂停、暂停→继续（同文件表交互） */
	function togglePlay(it: KitItem): void {
		player.toggle(`kit:${it.uid}`, `/f/${encodeURIComponent(it.id)}`);
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
				load: async (id) => {
					// fetch 不带 Range → 200 全量
					const r = await fetch(`/f/${encodeURIComponent(id)}`);
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return new Uint8Array(await r.arrayBuffer());
				},
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
	<!-- 收起态：右下角悬浮钮（GitHub 反馈钮左侧），badge 显示已放音效数 -->
	<button
		class="kit-fab"
		data-tour="kit"
		onclick={() => (kit.open = true)}
		title={t('kit.title')}
		aria-label={t('kit.title')}
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
	<div class="kit-panel" role="dialog" aria-label={t('kit.title')}>
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

		<div class="kit-grid">
			<div class="corner"></div>
			{#each KIT_COLS as col (col)}
				<div class="colhead">{col}</div>
			{/each}
			{#each KIT_ROWS as row (row)}
				<div class="rowhead">{row}</div>
				{#each KIT_COLS as col (col)}
					{@const key = cellKey(row, col)}
					<!-- 格子点击 = 多选入格的便捷路径；键盘等价物是 Q–V 快捷键（cellForKey），
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
							{@const target = `${row}-${col}${it.suffix}.${it.format}`}
							<div
								class="chip"
								role="listitem"
								class:dup={kit.dupTargets.has(target)}
								class:playing={playingUid === it.uid}
								title={kit.dupTargets.has(target) ? `${target} — ${t('kit.dupName')}` : target}
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

	/* 展开态：右下角浮层（z-index 低于对话框 100、高于内容） */
	.kit-panel {
		position: fixed;
		right: 16px;
		bottom: calc(68px + env(safe-area-inset-bottom, 0px));
		z-index: 60;
		width: min(760px, calc(100vw - 32px));
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
		grid-template-columns: 64px repeat(4, minmax(140px, 1fr));
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

	/* 多选时格角键帽字母：Q–V 只在键鼠（可悬停+精指针）设备有意义，
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
		.kit-hint {
			display: none;
		}
		.kit-grid {
			grid-template-columns: 44px repeat(4, minmax(120px, 140px));
		}
	}

	/* 超窄屏（≤480）：4 列全部挤进视口、格子区不再横向滚动；
	   chip 改两行网格，播放/序号/×都保 ≥28px 触点，名字让位省略号 */
	@media (max-width: 480px) {
		.kit-grid {
			grid-template-columns: 44px repeat(4, minmax(0, 1fr));
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
