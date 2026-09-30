<script lang="ts">
	// 文件表：列 = 播放指示+文件名 / 格式 / 时长 / 采样率 / 采样深度 / 声道 / 波形 / 下载
	// 文件名含 # 空格 & 逗号为常态，{f.name} 文本插值（Svelte 默认转义）；
	// URL 一律 encodeURIComponent（id 为 uuid，防御性编码）
	import type { FileRow } from '$lib/types';
	import { t } from '$lib/i18n';
	import { fetchPeaks, DND_FILE_MIME, type KitDragData } from '$lib/api';
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
		onplay?: (file: FileRow) => void;
		onseek?: (file: FileRow, ratio: number) => void;
	}
	let { files, playingId = null, paused = true, progress = 0, onplay, onseek }: Props = $props();

	/** FileRow → 入格载荷（只带所需三字段） */
	function toKitFile(f: FileRow): KitFile {
		return { id: f.id, name: f.name, format: f.format };
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

	// 波形按需缓存：undefined=未请求 null=无波形 number[]=已加载
	let peaksMap = $state<Record<string, number[] | null | undefined>>({});

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
						<td class="col-name" title={f.name}>
							{#if f.id === playingId}
								<!-- 播放指示：三根跳动条（暂停时静止） -->
								<span class="eq" class:paused aria-hidden="true"><i></i><i></i><i></i></span>
							{/if}
							{f.name}
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
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	td.col-name {
		color: var(--text);
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
