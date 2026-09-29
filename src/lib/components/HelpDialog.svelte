<script lang="ts">
	// 帮助对话框：顶栏「?」/ ? 键打开。分节说明 + 3×4 键位图 + 手势表 + 重开引导
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import type { Dict } from '$lib/i18n/zh';
	import { KIT_ROWS, KIT_COLS, CELL_LETTERS } from '$lib/kit.svelte';
	import { startTour } from '$lib/ui.svelte';

	interface Props {
		uploadEnabled: boolean;
		onclose: () => void;
	}
	let { uploadEnabled, onclose }: Props = $props();

	let cardEl = $state<HTMLElement | undefined>();
	onMount(() => {
		// 打开即聚焦关闭钮（与 MyPackages 一致：聚焦首个控件）；Esc 关闭
		cardEl?.querySelector<HTMLElement>('button, [tabindex]')?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// 手势表：键位/操作 → 效果
	const gestures: Array<[keyof Dict, keyof Dict]> = [
		['help.g.click', 'help.g.click.fx'],
		['help.g.wave', 'help.g.wave.fx'],
		['help.g.ctrl', 'help.g.ctrl.fx'],
		['help.g.shift', 'help.g.shift.fx'],
		['help.g.drag', 'help.g.drag.fx'],
		['help.g.qv', 'help.g.qv.fx'],
		['help.g.esc', 'help.g.esc.fx'],
		['help.g.help', 'help.g.help.fx']
	];
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('help.title')}>
	<div class="dialog-card card" bind:this={cardEl}>
		<h2>{t('help.title')}</h2>
		<button class="dialog-close" aria-label={t('upload.close')} onclick={onclose}>×</button>

		<section>
			<h3>{t('help.browse.title')}</h3>
			<p>{t('help.browse.body')}</p>
		</section>

		<section>
			<h3>{t('help.download.title')}</h3>
			<p>{t('help.download.body')}</p>
		</section>

		<section>
			<h3>{t('help.kit.title')}</h3>
			<p>{t('help.kit.body')}</p>
		</section>

		<section>
			<h3>{t('help.keymap.title')}</h3>
			<!-- 3×4 键位图：行 = normal/soft/drum，列 = hitnormal…hitclap -->
			<div class="keymap">
				<div class="corner"></div>
				{#each KIT_COLS as col (col)}
					<div class="colhead">{col}</div>
				{/each}
				{#each KIT_ROWS as row (row)}
					<div class="rowhead">{row}</div>
					{#each KIT_COLS as col (col)}
						<!-- 格子只放键帽字母（行列头已给出目标名）；全名留 title/aria-label -->
						<div class="key" role="img" title="{row}-{col}" aria-label="{row}-{col}">
							<span class="cap" aria-hidden="true">{CELL_LETTERS[`${row}/${col}`]}</span>
						</div>
					{/each}
				{/each}
			</div>
		</section>

		<section>
			<h3>{t('help.gestures.title')}</h3>
			<table class="gestures">
				<tbody>
					{#each gestures as [gk, fxk] (gk)}
						<tr>
							<td class="g">{t(gk)}</td>
							<td class="fx">{t(fxk)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if uploadEnabled}
			<section>
				<h3>{t('help.upload.title')}</h3>
				<p>{t('help.upload.body')}</p>
			</section>
		{/if}

		<div class="foot">
			<button
				class="btn"
				onclick={() => {
					onclose();
					startTour();
				}}
			>
				{t('help.restartTour')}
			</button>
		</div>
	</div>
</div>

<style>
	.card {
		width: min(620px, calc(100vw - 40px));
		max-height: 80vh;
		overflow: auto;
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	h3 {
		margin: 16px 0 6px;
		font-size: 13px;
		font-weight: 600;
		color: var(--accent-bright);
	}
	section:first-of-type h3 {
		margin-top: 0;
	}

	p {
		margin: 0;
		font-size: 13px;
		line-height: 1.7;
		color: var(--text-dim);
	}

	/* 键位图：格子带键帽字母 + 目标名 */
	.keymap {
		display: grid;
		grid-template-columns: 52px repeat(4, 1fr);
		gap: 5px;
		margin-top: 4px;
	}
	.keymap .colhead {
		text-align: center;
		font-size: 11px;
		color: var(--text-faint);
		font-weight: 600;
	}
	.keymap .rowhead {
		align-self: center;
		text-align: right;
		padding-right: 6px;
		font-size: 12px;
		color: var(--text-dim);
	}
	.key {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 7px 4px;
		border-radius: var(--radius);
		background: var(--bg-l3);
		min-width: 0;
	}
	.key .cap {
		min-width: 24px;
		height: 24px;
		padding: 0 5px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		background: var(--bg-inset);
		border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
		color: var(--accent-bright);
		font-size: 13px;
		font-weight: 700;
	}

	.gestures {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	.gestures td {
		padding: 4px 8px 4px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 40%, transparent);
		vertical-align: top;
	}
	.gestures .g {
		color: var(--text);
		white-space: nowrap;
	}
	.gestures .fx {
		color: var(--text-dim);
	}

	.foot {
		margin-top: 18px;
		display: flex;
		justify-content: flex-end;
	}

	@media (max-width: 768px) {
		.card {
			width: calc(100vw - 20px);
			padding: 14px;
		}
		.keymap {
			grid-template-columns: 44px repeat(4, 1fr);
		}
	}
</style>
