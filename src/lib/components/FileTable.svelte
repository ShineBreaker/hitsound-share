<script lang="ts">
	// 文件表：列 = 文件名 / 格式 / 时长 / 采样率 / 采样深度 / 声道 / 波形
	// 文件名含 # 空格 & 逗号为常态，{name} 直接文本插值（Svelte 默认转义）
	import type { FileRow } from '$lib/types';
	import { t } from '$lib/i18n';
	import WaveformCanvas from './WaveformCanvas.svelte';

	let { files = [] }: { files?: FileRow[] } = $props();

	/** 时长 mm:ss.s */
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
				</tr>
			</thead>
			<tbody>
				{#each files as f (f.id)}
					<tr>
						<td class="col-name" title={f.name}>{f.name}</td>
						<td class="col-num"><span class="fmt">{f.format.toUpperCase()}</span></td>
						<td class="col-num tnum">{fmtDuration(f.durationS)}</td>
						<td class="col-num tnum">{fmtSampleRate(f.sampleRate)}</td>
						<td class="col-num tnum">{fmtBitDepth(f.bitDepth)}</td>
						<td class="col-num">{fmtChannels(f.channels)}</td>
						<td class="col-wave">
							{#if f.peaks}
								<WaveformCanvas peaks={f.peaks} />
							{:else}
								<span class="no-peaks">{t('meta.unknown')}</span>
							{/if}
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
		height: 100%;
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

	tbody tr:hover td {
		background: color-mix(in srgb, var(--bg-l3) 55%, transparent);
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

	.no-peaks {
		color: var(--text-faint);
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
