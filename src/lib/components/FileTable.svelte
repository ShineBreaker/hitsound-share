<script lang="ts">
	// 文件表：列 = 播放指示+文件名 / 格式 / 时长 / 采样率 / 采样深度 / 声道 / 波形 / 下载
	// 文件名含 # 空格 & 逗号为常态，{f.name} 文本插值（Svelte 默认转义）；
	// URL 一律 encodeURIComponent（id 为 uuid，防御性编码）
	// 文件名 cell：上传者可管（文件级 owner / 管理员）hover 出笔形钮行内改名
	import type { FileRow } from '$lib/types';
	import { t } from '$lib/i18n';
	import { canManage, fetchPeaks, DND_FILE_MIME, type KitDragData, type Me } from '$lib/api';
	import { selection } from '$lib/selection.svelte';
	import type { KitFile } from '$lib/kit.svelte';
	import WaveformCanvas from './WaveformCanvas.svelte';

	interface Props {
		files: FileRow[];
		/** 当前播放行 id */
		playingId?: string | null;
		/** 当前播放是否暂停（指示条动画用） */
		paused?: boolean;
		/** 当前播放进度 0-1（仅播放行传入 WaveformCanvas） */
		progress?: number;
		me?: Me;
		onplay?: (file: FileRow) => void;
		onseek?: (file: FileRow, ratio: number) => void;
		/** 提交行内改名（file + 新名），返回是否成功；失败保持编辑态 */
		onrename?: (file: FileRow, name: string) => Promise<boolean>;
	}
	let {
		files,
		playingId = null,
		paused = true,
		progress = 0,
		me = { loggedIn: false },
		onplay,
		onseek,
		onrename
	}: Props = $props();

	/** FileRow → 入格载荷（只带所需三字段） */
	function toKitFile(f: FileRow): KitFile {
		return { id: f.id, name: f.name, format: f.format };
	}

	// 行内改名：表内 editingId 互斥（Enter 提交 / Esc 取消 / blur 放弃；失败红框保输入）
	let editingId = $state('');
	let editValue = $state('');
	let submitting = $state(false);
	let failed = $state(false);

	function canRename(f: FileRow): boolean {
		return onrename != null && canManage(me, f.ownerOsuId);
	}

	function nameTitle(f: FileRow): string {
		return f.ownerName ? `${f.name}\n${t('file.owner')}: ${f.ownerName}` : f.name;
	}

	function startEdit(f: FileRow): void {
		editValue = f.name;
		failed = false;
		editingId = f.id;
	}

	async function submitEdit(f: FileRow): Promise<void> {
		const name = editValue.trim();
		if (submitting) return;
		if (!name || name === f.name) {
			editingId = '';
			return;
		}
		submitting = true;
		const ok = (await onrename?.(f, name)) ?? true;
		submitting = false;
		if (ok) editingId = '';
		else {
			failed = true;
			setTimeout(() => (failed = false), 1500);
		}
	}

	// 表头全选框：全选当前已加载行 / 有选中则取消
	const allSelected = $derived(files.length > 0 && files.every((f) => selection.has(f.id)));
	const someSelected = $derived(files.some((f) => selection.has(f.id)));

	function toggleAll(): void {
		if (allSelected || someSelected) {
			// 已全选或部分选：把本页行从选中集移除
			const ids = new Set(files.map((f) => f.id));
			selection.items = selection.items.filter((i) => !ids.has(i.id));
		} else {
			selection.selectRange(files.map(toKitFile));
		}
	}

	/** 行点击：Ctrl/⌘ 切换单选，Shift 从锚点连选，裸点播放 */
	function rowClick(e: MouseEvent, f: FileRow): void {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			selection.toggle(toKitFile(f));
			return;
		}
		if (e.shiftKey) {
			e.preventDefault();
			const ai = files.findIndex((x) => x.id === selection.anchor);
			const ti = files.findIndex((x) => x.id === f.id);
			if (ai !== -1 && ti !== -1) {
				const [a, b] = ai < ti ? [ai, ti] : [ti, ai];
				selection.selectRange(files.slice(a, b + 1).map(toKitFile));
			} else {
				selection.toggle(toKitFile(f));
			}
			return;
		}
		onplay?.(f);
	}

	// 波形按需缓存：undefined=未请求 null=无波形 number[]=已加载；
	// 只保留当前 files 里存在的 id——翻页/删除/换文件夹后不留陈旧行
	let peaksMap = $state<Record<string, number[] | null | undefined>>({});

	$effect(() => {
		const ids = new Set(files.map((f) => f.id));
		for (const k of Object.keys(peaksMap)) {
			if (!ids.has(k)) delete peaksMap[k];
		}
	});

	async function wantPeaks(id: string): Promise<void> {
		if (id in peaksMap) return;
		peaksMap[id] = null; // 占位：标记已请求（null 期间 canvas 显示占位条）
		peaksMap[id] = await fetchPeaks(id);
	}

	/** 时长 m:ss.s */
	function fmtDuration(s: number | null): string {
		if (s == null) return t('meta.unknown');
		const m = Math.floor(s / 60);
		const sec = s - m * 60;
		return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
	}

	function fmtSampleRate(hz: number | null): string {
		return hz == null ? t('meta.unknown') : `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;
	}

	function fmtBitDepth(bits: number | null): string {
		return bits == null ? t('meta.unknown') : `${bits} bit`;
	}

	function fmtChannels(c: number | null): string {
		if (c == null) return t('meta.unknown');
		if (c === 1) return t('meta.channels.mono');
		if (c === 2) return t('meta.channels.stereo');
		return t('meta.channels.n', { count: c });
	}

	function playTitle(f: FileRow): string {
		if (f.id !== playingId) return t('action.play');
		return paused ? t('action.play') : t('action.pause');
	}
</script>

<div class="table-wrap">
	{#if files.length === 0}
		<div class="empty">{t('table.empty')}</div>
	{:else}
		<table>
			<thead>
				<tr>
					<th class="col-sel">
						<button
							class="selbox"
							class:on={allSelected}
							class:part={!allSelected && someSelected}
							data-tour="select"
							role="checkbox"
							aria-checked={allSelected ? 'true' : someSelected ? 'mixed' : 'false'}
							title={t('sel.all')}
							aria-label={t('sel.all')}
							onclick={toggleAll}
						></button>
					</th>
					<th class="col-name">{t('file.name')}</th>
					<th class="col-num">{t('file.format')}</th>
					<th class="col-num">{t('file.duration')}</th>
					<th class="col-num col-meta">{t('file.sampleRate')}</th>
					<th class="col-num col-meta">{t('file.bitDepth')}</th>
					<th class="col-num col-meta">{t('file.channels')}</th>
					<th class="col-wave">{t('file.waveform')}</th>
					<th class="col-dl"><span class="sr-only">{t('action.download')}</span></th>
				</tr>
			</thead>
			<tbody>
				{#each files as f (f.id)}
					<tr
						class:playing={f.id === playingId}
						class:selected={selection.has(f.id)}
						draggable="true"
						ondragstart={(e) => {
							// 供底部组装面板接收：自定义 MIME，drop 侧按 types 判断来源；
							// 拖的是多选中行时整组按选中顺序入格（续号），否则单行无序号
							const kf = toKitFile(f);
							const files2 =
								selection.size > 1 && selection.has(f.id) ? [...selection.items] : [kf];
							const data: KitDragData = { files: files2 };
							e.dataTransfer?.setData(DND_FILE_MIME, JSON.stringify(data));
							if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
						}}
						onclick={(e) => rowClick(e, f)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault(); // Space 默认滚动页面，需拦下
								onplay?.(f);
							}
						}}
						role="button"
						tabindex="0"
						aria-label={playTitle(f)}
					>
						<td class="col-sel">
							<button
								class="selbox"
								class:on={selection.has(f.id)}
								role="checkbox"
								aria-checked={selection.has(f.id)}
								title={t('sel.row')}
								aria-label={t('sel.row')}
								onclick={(e) => {
									e.stopPropagation(); // 勾选不触发行播放
									selection.toggle(toKitFile(f));
								}}
							></button>
						</td>
						<td class="col-name" title={nameTitle(f)}>
							{#if editingId === f.id}
								<input
									class="edit"
									class:failed
									bind:value={editValue}
									disabled={submitting}
									maxlength="100"
									title={failed ? t('rename.failed') : undefined}
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => {
										// 阻止冒泡到行（Enter/Space 会触发行播放）
										e.stopPropagation();
										if (e.key === 'Enter') void submitEdit(f);
										else if (e.key === 'Escape') editingId = '';
									}}
									onblur={() => {
										// blur 即放弃（点击他处/Tab）；Enter 提交，Esc 取消
										if (editingId === f.id) editingId = '';
									}}
								/>
							{:else}
								<div class="name-cell">
									{#if f.id === playingId}
										<!-- 播放指示：三根跳动条（暂停时静止） -->
										<span class="eq" class:paused aria-hidden="true"><i></i><i></i><i></i></span>
									{/if}
									<span class="fname">{f.name}</span>
									{#if canRename(f)}
										<button
											class="rn"
											title={t('action.rename')}
											aria-label={t('action.rename')}
											onclick={(e) => {
												e.stopPropagation();
												startEdit(f);
											}}
										>
											<!-- 与树节点改名同款笔形（Comfortaa 无 ✎ 字形） -->
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
										</button>
									{/if}
								</div>
							{/if}
						</td>
						<td class="col-num"><span class="fmt">{f.format.toUpperCase()}</span></td>
						<td class="col-num tnum">{fmtDuration(f.durationS)}</td>
						<td class="col-num tnum col-meta">{fmtSampleRate(f.sampleRate)}</td>
						<td class="col-num tnum col-meta">{fmtBitDepth(f.bitDepth)}</td>
						<td class="col-num col-meta">{fmtChannels(f.channels)}</td>
						<td class="col-wave">
							<WaveformCanvas
								peaks={peaksMap[f.id]}
								progress={f.id === playingId ? progress : 0}
								onvisible={() => void wantPeaks(f.id)}
								onseek={(ratio) => onseek?.(f, ratio)}
							/>
						</td>
						<td class="col-dl">
							<a
								class="dl"
								href={`/f/${encodeURIComponent(f.id)}/download`}
								download={f.name}
								title={t('action.download')}
								aria-label={t('action.download')}
								onclick={(e) => e.stopPropagation()}
							>
								<!-- Comfortaa 无 ⤓ 字形，用内联 SVG -->
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
							</a>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<div class="count">{t('table.fileCount', { count: files.length })}</div>
	{/if}
</div>

<style>
	.table-wrap {
		flex: 1;
		overflow: auto;
		display: flex;
		flex-direction: column;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	th {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--bg-l2);
		color: var(--text-faint);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid var(--bg-l3);
		white-space: nowrap;
	}

	td {
		padding: 5px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 40%, transparent);
		color: var(--text-dim);
		vertical-align: middle;
		transition: background 0.12s ease;
	}

	tbody tr {
		cursor: pointer;
		user-select: none; /* 防止 Shift/Ctrl 连点选中整页文本 */
		/* 长表行级渲染裁剪（试点）：离屏行由浏览器跳过子树渲染，进视口自动
		   恢复（与 WaveformCanvas 的 IO 释放互补：一个省 paint，一个省位图）。
		   auto 关键字让 Chromium 记忆已渲染行的真实尺寸、以 47px 为冷启动
		   估值（行内最高元素 = 波形 36px + td 上下 padding 5px×2 + 行边框 1px），
		   把 contain-intrinsic-size 估值与实际行高的偏差压到首渲染一次 */
		content-visibility: auto;
		contain-intrinsic-size: auto 47px;
	}
	tbody tr:hover td {
		background: color-mix(in srgb, var(--bg-l3) 55%, transparent);
		color: var(--text);
	}

	/* 多选中行：薄荷 ~10% 底（比播放行的 14% 略弱，叠加时播放态为准） */
	tbody tr.selected td {
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	tbody tr.selected:hover td {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	/* 播放行：薄荷淡底 + 左侧 3px 内嵌薄荷条（编辑器选中行同款） */
	tbody tr.playing td {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text);
	}
	tbody tr.playing td:first-child {
		box-shadow: inset 3px 0 0 var(--accent);
	}

	/* 多选勾选列：按钮 32px 触控目标，内嵌 15px 视觉框 */
	.col-sel {
		width: 40px;
		padding: 0 4px;
		text-align: center;
	}
	.selbox {
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		cursor: pointer;
		padding: 0;
		border-radius: var(--radius);
	}
	.selbox::before {
		content: '';
		width: 15px;
		height: 15px;
		border-radius: 4px;
		border: 1.5px solid var(--text-faint);
		background: var(--bg-inset);
		transition:
			border-color 0.12s ease,
			background 0.12s ease;
	}
	.selbox:hover::before {
		border-color: var(--accent);
	}
	.selbox.on::before {
		border-color: var(--accent);
		background: var(--accent)
			url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 6.5 5 9.5 10 3' fill='none' stroke='%231e231e' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E")
			center / 11px no-repeat;
	}
	.selbox.part::before {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 45%, var(--bg-inset));
	}

	.col-name {
		max-width: 320px;
		overflow: hidden;
		white-space: nowrap;
	}
	td.col-name {
		color: var(--text);
	}
	/* 名字 cell 内布局：指示条 + 文件名（截断）+ 行内改名笔形钮 */
	.name-cell {
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.fname {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* 行内改名输入：占满名字 cell，与树节点改名同风格 */
	.edit {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding: 3px 8px;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
	}
	.edit:focus {
		outline: none;
	}
	.edit:disabled {
		opacity: 0.6;
	}
	/* 提交失败：红框 1.5s 提示（保持编辑态，输入不丢） */
	.edit.failed {
		border-color: var(--accent-pink);
	}

	/* 行内改名钮：与下载钮同款 hover 浮现，触屏常显（DESIGN.md） */
	.rn {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		margin-left: 2px;
		padding: 0;
		border: none;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-faint);
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.rn svg {
		width: 13px;
		height: 13px;
	}
	tr:hover .rn,
	tr.playing .rn,
	.rn:focus-visible {
		opacity: 1;
	}
	@media (hover: none) {
		.rn {
			opacity: 1;
		}
	}
	.rn:hover {
		background: var(--bg-l3);
		color: var(--accent-bright);
	}

	.col-num {
		width: 88px;
		text-align: right;
		white-space: nowrap;
	}

	.col-wave {
		width: 220px;
	}

	.col-dl {
		width: 36px;
		text-align: center;
	}

	/* 格式徽章 */
	.fmt {
		display: inline-block;
		padding: 1px 7px;
		border-radius: var(--radius);
		background: var(--bg-l3);
		color: var(--text-dim);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.5px;
	}
	tr.playing .fmt {
		background: color-mix(in srgb, var(--accent) 25%, transparent);
		color: var(--accent-bright);
	}

	/* 播放指示条：等高动画，暂停时静止并降为半透明 */
	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 12px;
		margin-right: 7px;
		vertical-align: middle;
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
	.eq.paused i {
		animation-play-state: paused;
		opacity: 0.5;
	}
	@keyframes eq {
		from {
			transform: scaleY(0.4);
		}
		to {
			transform: scaleY(1);
		}
	}

	/* 行内下载按钮：hover 浮现 */
	.dl {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius);
		color: var(--text-faint);
		text-decoration: none;
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.dl svg {
		width: 14px;
		height: 14px;
	}
	tr:hover .dl,
	tr.playing .dl,
	.dl:focus-visible {
		opacity: 1;
	}
	.dl:hover {
		background: var(--bg-l3);
		color: var(--accent-bright);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.empty {
		padding: 48px 0;
		text-align: center;
		color: var(--text-faint);
	}

	.count {
		padding: 10px 12px;
		color: var(--text-faint);
		font-size: 12px;
		text-align: right;
	}

	/* 窄屏：隐藏采样率/位深/声道三列，行高加到触控尺寸 */
	@media (max-width: 768px) {
		.col-meta {
			display: none;
		}
		td {
			padding-top: 10px;
			padding-bottom: 10px;
		}
		/* 窄屏行高更大（触控 padding 10px×2）：同步抬高行级裁剪的冷启动估值 */
		tbody tr {
			contain-intrinsic-size: auto 57px;
		}
		tbody tr {
			min-height: 44px;
		}
		.col-name {
			max-width: 40vw;
		}
		.col-wave {
			width: 120px;
		}
	}
</style>
