<script lang="ts">
	// 波形画布：peaks 渲染为居中对称柱状，紫色渐变；
	// 播放进度 progress(0-1) 左侧实色、右侧半透明（M3 接音频播放后驱动）
	import { onMount } from 'svelte';

	let { peaks = [], progress = 0 }: { peaks?: number[] | null; progress?: number } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();

	function draw(): void {
		if (!canvas) return;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (!w || !h || !peaks || peaks.length === 0) return;

		// 按 devicePixelRatio 缩放，保证高分屏清晰
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);

		// 垂直渐变：亮紫 → 主紫 → 亮紫
		const grad = ctx.createLinearGradient(0, 0, 0, h);
		grad.addColorStop(0, '#b299ff');
		grad.addColorStop(0.5, '#8c66ff');
		grad.addColorStop(1, '#b299ff');
		ctx.fillStyle = grad;

		const n = peaks.length;
		const step = w / n;
		for (let i = 0; i < n; i++) {
			const amp = Math.max(0.03, peaks[i]);
			const barH = amp * (h - 2);
			ctx.globalAlpha = i / n <= progress ? 1 : 0.45;
			ctx.fillRect(i * step, (h - barH) / 2, Math.max(1, step * 0.7), barH);
		}
		ctx.globalAlpha = 1;
	}

	// peaks / progress 变化即重绘
	$effect(() => {
		void peaks;
		void progress;
		draw();
	});

	onMount(() => {
		// 容器宽度变化（窗口缩放/面板拖拽）时重绘
		const ro = new ResizeObserver(() => draw());
		ro.observe(canvas!);
		return () => ro.disconnect();
	});
</script>

<canvas bind:this={canvas} class="wave"></canvas>

<style>
	.wave {
		display: block;
		width: 100%;
		height: 36px;
	}
</style>
