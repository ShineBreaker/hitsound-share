<script lang="ts">
	// 文件表：列 = 播放指示+文件名 / 格式 / 时长 / 采样率 / 采样深度 / 声道 / 波形 / 下载
	// 文件名含 # 空格 & 逗号为常态，{f.name} 文本插值（Svelte 默认转义）；
	// URL 一律 encodeURIComponent（id 为 uuid，防御性编码）
	import type { FileRow } from '$lib/types';
	import { t } from '$lib/i18n';
	import { fetchPeaks } from '$lib/api';
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
					<th class="col-name">{t('file.name')}</th>
					<th class="col-num">{t('file.format')}</th>
					<th class="col-num">{t('file.duration')}</th>
					<th class="col-num">{t('file.sampleRate')}</th>
					<th class="col-num">{t('file.bitDepth')}</th>
					<th class="col-num">{t('file.channels')}</th>
					<th class="col-wave">{t('file.waveform')}</th>
					<th class="col-dl"><span class="sr-only">{t('action.download')}</span></th>
				</tr>
			</thead>
			<tbody>
				{#each files as f (f.id)}
					<tr
						class:playing={f.id === playingId}
						onclick={() => onplay?.(f)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') onplay?.(f);
						}}
						role="button"
						tabindex="0"
						aria-label={playTitle(f)}
					>
						<td class="col-name" title={f.name}>
							{#if f.id === playingId}
								<!-- 播放指示：三根跳动条（暂停时静止） -->
								<span class="eq" class:paused aria-hidden="true"><i></i><i></i><i></i></span>
							{/if}
							{f.name}
						</td>
						<td class="col-num"><span class="fmt">{f.format.toUpperCase()}</span></td>
						<td class="col-num tnum">{fmtDuration(f.durationS)}</td>
						<td class="col-num tnum">{fmtSampleRate(f.sampleRate)}</td>
						<td class="col-num tnum">{fmtBitDepth(f.bitDepth)}</td>
						<td class="col-num">{fmtChannels(f.channels)}</td>
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
								⤓
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
		color: var(--accent-bright);
		font-weight: 600;
		text-align: left;
		padding: 8px 10px;
		border-bottom: 1px solid var(--bg-l3);
		white-space: nowrap;
	}

	td {
		padding: 5px 10px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 45%, transparent);
		color: var(--text-dim);
		vertical-align: middle;
	}

	tbody tr {
		cursor: pointer;
	}
	tbody tr:hover td {
		background: color-mix(in srgb, var(--bg-l3) 55%, transparent);
		color: var(--text);
	}

	/* 播放行高亮 */
	tbody tr.playing td {
		background: color-mix(in srgb, var(--accent) 16%, transparent);
		color: var(--text);
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
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		color: var(--accent-bright);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.5px;
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
		display: inline-block;
		width: 24px;
		height: 24px;
		line-height: 22px;
		text-align: center;
		border-radius: var(--radius);
		color: var(--text-faint);
		text-decoration: none;
		font-size: 15px;
		opacity: 0;
		transition: opacity 0.15s ease;
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
</style>
