<script lang="ts">
	// 波形画布：peaks 渲染为居中对称柱状（薄荷渐变，色值取自 CSS 变量）；
	// - progress(0-1)：已播部分实色、未播半透明
	// - 点击波形任意位置 → onseek(比例)，由上层完成跳播
	// - 可见性经 IntersectionObserver：滚出视口释放 canvas 位图（长列表省显存），
	//   首次进入视口（含 100px 预载边距）触发上层按需拉取 peaks
	import { onMount } from 'svelte';

	// 模块级共享 observer：FileTable 2400+ 行时每行 canvas 各建一对
	// IO/RO = 4800 个实例（回调调度与内存随行数放大）。共享后实例数恒为 2，
	// 回调按 WeakMap<canvas, cb> 路由——canvas 经弱引用作键，即使漏 unobserve
	// 也不阻止组件回收；unmount 时的 unobserve 是确定性清理（不留回调人口）
	let sharedIO: IntersectionObserver | null = null;
	let sharedRO: ResizeObserver | null = null;
	const visibleCbs = new WeakMap<Element, (visible: boolean) => void>();
	const resizeCbs = new WeakMap<Element, () => void>();

	function observeVisible(el: Element, cb: (visible: boolean) => void): void {
		sharedIO ??= new IntersectionObserver(
			(entries) => {
				for (const e of entries) visibleCbs.get(e.target)?.(e.isIntersecting);
			},
			{ rootMargin: '100px' }
		);
		visibleCbs.set(el, cb);
		sharedIO.observe(el);
	}

	function unobserveVisible(el: Element): void {
		sharedIO?.unobserve(el);
		visibleCbs.delete(el);
	}

	function observeResize(el: Element, cb: () => void): void {
		sharedRO ??= new ResizeObserver((entries) => {
			for (const e of entries) resizeCbs.get(e.target)?.();
		});
		resizeCbs.set(el, cb);
		sharedRO.observe(el);
	}

	function unobserveResize(el: Element): void {
		sharedRO?.unobserve(el);
		resizeCbs.delete(el);
	}

	interface Props {
		peaks?: number[] | null;
		progress?: number;
		onseek?: (ratio: number) => void;
		onvisible?: () => void;
	}
	let { peaks, progress = 0, onseek, onvisible }: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let inView = $state(false); // 画布是否在视口（离屏位图清零省显存）
	let colBright = '#8ceec8'; // mount 时由 CSS 变量覆盖（兜底值与主题一致）
	let colAccent = '#3fd8a0';

	function draw(): void {
		if (!canvas || !inView) return;
		const w = canvas.clientWidth;
		const h = canvas.clientHeight;
		if (!w || !h || !peaks || peaks.length === 0) return;

		// 按 devicePixelRatio 缩放，保证高分屏清晰
		const dpr = window.devicePixelRatio || 1;
		const pw = Math.round(w * dpr);
		const ph = Math.round(h * dpr);
		if (canvas.width !== pw || canvas.height !== ph) {
			canvas.width = pw;
			canvas.height = ph;
		}
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

	// peaks / progress / 可见性 变化即重绘
	$effect(() => {
		void peaks;
		void progress;
		void inView;
		draw();
	});

	onMount(() => {
		// 主题色取自 CSS 变量（DESIGN.md：画布不落裸色值）
		const cs = getComputedStyle(document.documentElement);
		colBright = cs.getPropertyValue('--accent-bright').trim() || colBright;
		colAccent = cs.getPropertyValue('--accent').trim() || colAccent;
		// 容器宽度变化（窗口缩放）时重绘
		observeResize(canvas!, () => draw());
		let peaksFetched = false;
		// 进入视口拉 peaks+重绘，离开即清零位图释放显存（100px 预载语义不变）
		observeVisible(canvas!, (visible) => {
			if (visible) {
				inView = true;
				if (!peaksFetched) {
					peaksFetched = true;
					onvisible?.(); // peaks 只需首见拉一次
				}
				draw();
			} else {
				inView = false;
				if (canvas) canvas.width = 0; // 释放离屏位图
			}
		});
		return () => {
			unobserveResize(canvas!);
			unobserveVisible(canvas!);
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
