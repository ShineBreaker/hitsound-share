<script lang="ts">
	// 波形画布：peaks 渲染为居中对称柱状（薄荷渐变，色值取自 CSS 变量）；
	// - progress(0-1)：已播部分实色、未播半透明
	// - 点击波形任意位置 → onseek(比例)，由上层完成跳播
	// - 进入视口时 onvisible() 一次，触发上层按需拉取 peaks
	import { onMount } from 'svelte';

	interface Props {
		peaks?: number[] | null;
		progress?: number;
		onseek?: (ratio: number) => void;
		onvisible?: () => void;
	}
	let { peaks, progress = 0, onseek, onvisible }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let colBright = '#8ceec8'; // mount 时由 CSS 变量覆盖（兜底值与主题一致）
	let colAccent = '#3fd8a0';

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

		// 垂直渐变：亮薄荷 → 主薄荷 → 亮薄荷
		const grad = ctx.createLinearGradient(0, 0, 0, h);
		grad.addColorStop(0, colBright);
		grad.addColorStop(0.5, colAccent);
		grad.addColorStop(1, colBright);
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
		// 主题色取自 CSS 变量（DESIGN.md：画布不落裸色值）
		const cs = getComputedStyle(document.documentElement);
		colBright = cs.getPropertyValue('--accent-bright').trim() || colBright;
		colAccent = cs.getPropertyValue('--accent').trim() || colAccent;
		// 容器宽度变化（窗口缩放）时重绘
		const ro = new ResizeObserver(() => draw());
		ro.observe(canvas!);
		// 进入视口（含 100px 预载边距）才拉 peaks，长列表省流量
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					io.disconnect();
					onvisible?.();
				}
			},
			{ rootMargin: '100px' }
		);
		io.observe(canvas!);
		return () => {
			ro.disconnect();
			io.disconnect();
		};
	});
</script>

<canvas
	bind:this={canvas}
	class="wave"
	class:placeholder={!peaks}
	onclick={(e) => {
		// 点击必须止步于画布：冒泡到行会触发行的 onclick（togglePlay），刚跳播完又被暂停
		e.stopPropagation();
		const rect = canvas!.getBoundingClientRect();
		onseek?.(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
	}}
></canvas>

<style>
	.wave {
		display: block;
		width: 100%;
		height: 36px;
		cursor: pointer;
	}

	/* peaks 未到位时给一条低对比占位底，避免闪空 */
	.wave.placeholder {
		cursor: default;
		background: linear-gradient(
			180deg,
			transparent 35%,
			color-mix(in srgb, var(--bg-l3) 70%, transparent) 50%,
			transparent 65%
		);
	}
</style>
