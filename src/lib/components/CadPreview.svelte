<script lang="ts">
	// osu!cad 实时预览悬浮窗：标题栏可拖拽、右下角可缩放；iframe 指向 static/osucad 产物。
	// 格子/谱面集任何变化 → 防抖后 cad.invalidate() → 重发合并包 → iframe 内热更新
	// （重建 Skin 触发 sourceChanged，SkinnableSound 重取解码缓存——不重载页面）。
	import { onDestroy, onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { cad } from '$lib/cad.svelte';
	import { kit } from '$lib/kit.svelte';
	import { osz } from '$lib/osz.svelte';

	let frame = $state<HTMLIFrameElement | undefined>();

	// 悬浮窗位置：默认锚定右上，标题栏拖动后改自由定位
	let x = $state(0);
	let y = $state(0);
	let placed = $state(false);
	let dragging = $state(false);

	// 进度条拖动期间不被 cad:time 回写干扰
	let seeking = $state(false);

	// 内容变化 → 防抖热更新（subscribe 依赖：kit.entries/osz.entries 的每次读取）
	let debounce: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		void kit.entries;
		void osz.entries;
		if (!cad.open) return;
		clearTimeout(debounce);
		debounce = setTimeout(() => cad.invalidate(), 350);
	});

	$effect(() => {
		cad.frame = frame ?? null;
	});

	function onMessage(e: MessageEvent): void {
		if (!frame || e.source !== frame.contentWindow) return;
		if (e.origin !== location.origin) return;
		cad.onMessage(e.data);
	}

	onMount(() => {
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});

	onDestroy(() => {
		clearTimeout(debounce);
		if (cad.frame === frame) cad.frame = null;
	});

	/** 标题栏拖动：pointer 捕获，窗口跟随；点在按钮/进度条上不拖窗 */
	function dragStart(e: PointerEvent): void {
		if ((e.target as HTMLElement | null)?.closest('button,input')) return;
		const el = (e.currentTarget as HTMLElement).closest('.cad-win') as HTMLElement | null;
		if (!el) return;
		placed = true;
		x = el.offsetLeft;
		y = el.offsetTop;
		dragging = true;
		const sx = e.clientX - x;
		const sy = e.clientY - y;
		const move = (ev: PointerEvent) => {
			x = Math.min(Math.max(0, ev.clientX - sx), window.innerWidth - 80);
			y = Math.min(Math.max(0, ev.clientY - sy), window.innerHeight - 40);
		};
		const up = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	function onSeek(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		cad.control('seek', v);
	}

	function fmt(ms: number): string {
		const s = Math.max(0, Math.floor(ms / 1000));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	const metaLine = $derived.by(() => {
		const m = cad.meta;
		if (!m) return '';
		return [m.artist, m.title, `[${m.version}]`, `by ${m.creator}`].filter(Boolean).join(' ');
	});
</script>

<div
	class="cad-win"
	class:dragging
	style={placed ? `left:${x}px;top:${y}px;right:auto;bottom:auto` : ''}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="cad-bar" role="toolbar" aria-label={t('cad.title')} onpointerdown={dragStart}>
		<button
			class="pp"
			onclick={() => cad.control(cad.playing ? 'pause' : 'play')}
			aria-label={cad.playing ? t('action.pause') : t('action.play')}
			disabled={!cad.loaded}
		>
			{cad.playing ? '⏸' : '▶'}
		</button>
		<input
			class="prog"
			type="range"
			min="0"
			max={Math.max(1, cad.duration)}
			step="1"
			value={seeking ? undefined : cad.time}
			disabled={!cad.loaded}
			onpointerdown={() => (seeking = true)}
			onpointerup={() => (seeking = false)}
			oninput={onSeek}
			aria-label={t('cad.seek')}
		/>
		<span class="clock">{fmt(cad.time)} / {fmt(cad.duration)}</span>
		<span class="meta" title={metaLine}>{metaLine}</span>
		<button
			class="collapse"
			title={t('cad.close')}
			aria-label={t('cad.close')}
			onclick={() => cad.close()}
		>
			×
		</button>
	</div>
	{#if cad.loaded && cad.meta}
		<div class="cad-sub">
			{#if cad.meta.difficulties.length > 1}
				<select
					class="diff"
					aria-label={t('cad.difficulty')}
					title={t('cad.difficulty')}
					value={cad.meta.difficultyIndex}
					onchange={e => cad.selectDifficulty(Number(e.currentTarget.value))}
				>
					{#each cad.meta.difficulties as d, i (i)}
						<option value={i}>{d}</option>
					{/each}
				</select>
			{/if}
			<label class="vol">
				<span>{t('cad.music')}</span>
				<input
					type="range"
					min="0"
					max="100"
					value={Math.round(cad.volMusic * 100)}
					oninput={e => cad.setVolume('music', Number(e.currentTarget.value) / 100)}
				/>
			</label>
			<label class="vol">
				<span>{t('cad.effects')}</span>
				<input
					type="range"
					min="0"
					max="100"
					value={Math.round(cad.volEffects * 100)}
					oninput={e => cad.setVolume('effects', Number(e.currentTarget.value) / 100)}
				/>
			</label>
		</div>
	{/if}
	<div class="cad-body">
		<iframe
			bind:this={frame}
			src="/osucad/index.html"
			title={t('cad.title')}
			allow="autoplay"
		></iframe>
		{#if cad.error}
			<div class="cad-veil err">{cad.error}</div>
		{:else if !cad.loaded}
			<div class="cad-veil">{t('cad.loading')}</div>
		{:else if cad.meta && !cad.meta.hasAudio}
			<div class="cad-note">{t('cad.noAudio')}</div>
		{/if}
	</div>
</div>

<style>
	/* 悬浮预览窗：默认右上角（面板上方），可拖动可缩放；z-index 高于组装面板 */
	.cad-win {
		position: fixed;
		top: 64px;
		right: 16px;
		z-index: 70;
		width: min(720px, calc(100vw - 32px));
		height: min(540px, calc(100vh - 120px));
		min-width: 320px;
		min-height: 240px;
		display: flex;
		flex-direction: column;
		background: var(--bg-l2);
		border: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
		overflow: hidden;
		resize: both;
	}
	.cad-win.dragging {
		user-select: none;
	}
	.cad-win.dragging .cad-body {
		pointer-events: none; /* 拖动时 iframe 不吞指针事件 */
	}

	.cad-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px;
		min-height: 34px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		cursor: grab;
		touch-action: none;
	}
	.cad-win.dragging .cad-bar {
		cursor: grabbing;
	}

	.pp {
		flex: none;
		width: 24px;
		height: 24px;
		border: none;
		background: transparent;
		color: var(--accent-bright);
		font-size: 11px;
		cursor: pointer;
		border-radius: var(--radius);
	}
	.pp:hover {
		background: var(--bg-l3);
	}
	.pp:disabled {
		color: var(--text-faint);
		cursor: default;
	}

	.prog {
		flex: 1;
		min-width: 60px;
		accent-color: var(--accent);
	}

	.clock {
		flex: none;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim);
	}

	.meta {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		color: var(--text-faint);
	}

	.collapse {
		flex: none;
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

	/* 第二行：难度选择 + 音乐/音效音量 */
	.cad-sub {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 2px 10px;
		min-height: 26px;
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
	}
	.diff {
		flex: 0 1 auto;
		min-width: 0;
		max-width: 45%;
		padding: 1px 4px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-l1);
		color: var(--text-dim);
		font-size: 11px;
		font-family: inherit;
	}
	.vol {
		flex: none;
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		color: var(--text-faint);
	}
	.vol input[type='range'] {
		width: 84px;
		accent-color: var(--accent);
	}

	.cad-body {
		flex: 1;
		position: relative;
		min-height: 0;
		background: #000;
	}
	.cad-body iframe {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		display: block;
	}

	/* 装载中遮罩 / 错误提示 / 无音轨角标 */
	.cad-veil {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg-l1) 82%, transparent);
		color: var(--text-dim);
		font-size: 13px;
	}
	.cad-veil.err {
		color: var(--accent-pink);
		padding: 0 24px;
		text-align: center;
	}
	.cad-note {
		position: absolute;
		right: 8px;
		bottom: 8px;
		padding: 2px 8px;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--bg-l1) 80%, transparent);
		color: var(--text-faint);
		font-size: 11px;
		pointer-events: none;
	}
</style>
