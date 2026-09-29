<script lang="ts">
	// 新手引导：首次访问在页面就绪（树 + 首包文件已加载，见 +page 的 ui.pageReady）后自动开始；
	// 聚光灯 = 目标矩形 + 巨型 box-shadow 挖洞遮罩；气泡卡自适应上下方位、贴屏夹取、窄屏吸底。
	// Esc/跳过/完成 → endTour() 写 hs_tour_v1；帮助对话框可 startTour() 重开。
	import { onMount, tick } from 'svelte';
	import { t } from '$lib/i18n';
	import { TOUR_STEPS, visibleSteps, type TourStep } from '$lib/tour';
	import { ui, startTour, endTour, tourDone } from '$lib/ui.svelte';

	let steps = $state<TourStep[]>([]);
	let idx = $state(0);
	let spot = $state<{ x: number; y: number; w: number; h: number } | null>(null);
	let cardPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });
	let cardEl = $state<HTMLElement | undefined>();

	const step = $derived(steps[idx] ?? null);

	const SPOT_PAD = 6; // 聚光灯比目标外扩的像素
	const CARD_GAP = 10;

	function targetEl(sel: string): HTMLElement | null {
		return document.querySelector<HTMLElement>(sel);
	}

	/** 目标「存在且可见」：在 DOM 中、有尺寸、且与视口相交（窄屏抽屉离屏 → 该步跳过） */
	function usable(sel: string): boolean {
		const el = targetEl(sel);
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return (
			r.width > 0 &&
			r.height > 0 &&
			r.bottom > 0 &&
			r.right > 0 &&
			r.left < window.innerWidth &&
			r.top < window.innerHeight
		);
	}

	/** 量取当前步目标 → 更新聚光灯与卡片位置（需等卡片渲染后量高宽） */
	async function measure(): Promise<void> {
		if (!step) return;
		const el = targetEl(step.sel);
		if (!el) {
			// 目标中途消失：跳下一步；到头则结束
			if (idx < steps.length - 1) {
				idx += 1;
			} else {
				finish();
			}
			return;
		}
		const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'instant' : 'smooth' });
		await tick();
		await new Promise((r) => requestAnimationFrame(r));
		const r = el.getBoundingClientRect();
		spot = {
			x: r.x - SPOT_PAD,
			y: r.y - SPOT_PAD,
			w: r.width + SPOT_PAD * 2,
			h: r.height + SPOT_PAD * 2
		};
		await tick();
		placeCard();
	}

	function placeCard(): void {
		if (!spot || !cardEl) return;
		const cw = cardEl.offsetWidth;
		const ch = cardEl.offsetHeight;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// 窄屏（卡片吸底由 CSS 控制）仍算横向居中
		let x = spot.x + spot.w / 2 - cw / 2;
		x = Math.max(10, Math.min(x, vw - cw - 10));
		let y: number;
		if (spot.y + spot.h + CARD_GAP + ch <= vh - 10) {
			y = spot.y + spot.h + CARD_GAP; // 下方放得下 → 放下面
		} else if (spot.y - CARD_GAP - ch >= 10) {
			y = spot.y - CARD_GAP - ch; // 放不下 → 放上面
		} else {
			y = Math.max(10, vh - ch - 10); // 都不够 → 贴底
		}
		cardPos = { x, y };
	}

	function next(): void {
		if (idx >= steps.length - 1) finish();
		else idx += 1;
	}
	function prev(): void {
		if (idx > 0) idx -= 1;
	}
	function finish(): void {
		endTour(); // 写完成标记
		steps = [];
		spot = null;
	}

	// 激活时筛出当前存在且可见的目标（上传钮缺席 / 窄屏抽屉离屏都跳过），从第 0 步开始量位
	$effect(() => {
		if (ui.tourActive) {
			const list = visibleSteps(TOUR_STEPS, usable);
			if (list.length === 0) {
				finish();
				return;
			}
			idx = 0;
			steps = list;
		} else {
			steps = [];
			spot = null;
		}
	});

	// 步进/步数变化 → 重新量位
	$effect(() => {
		if (ui.tourActive && step) void measure();
	});

	onMount(() => {
		// 首次访问自动开始：页面就绪（树+首包文件加载完）且未看过引导
		const stop = $effect.root(() => {
			$effect(() => {
				if (ui.pageReady && !ui.tourActive && !tourDone()) startTour();
			});
		});
		const onKey = (e: KeyboardEvent) => {
			if (!ui.tourActive) return;
			if (e.key === 'Escape') finish();
			else if (e.key === 'ArrowRight') next();
			else if (e.key === 'ArrowLeft') prev();
		};
		const onReflow = () => void measure();
		window.addEventListener('keydown', onKey);
		window.addEventListener('resize', onReflow);
		window.addEventListener('scroll', onReflow, true); // 捕获内部滚动容器
		return () => {
			stop();
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', onReflow);
			window.removeEventListener('scroll', onReflow, true);
		};
	});
</script>

{#if ui.tourActive && step && spot}
	<!-- 聚光灯：目标矩形外扩一圈 + 9999px 阴影挖洞出遮罩 -->
	<div
		class="spot"
		style:left="{spot.x}px"
		style:top="{spot.y}px"
		style:width="{spot.w}px"
		style:height="{spot.h}px"
	></div>
	<div
		class="tour-card"
		role="dialog"
		aria-modal="true"
		aria-label={step.title}
		bind:this={cardEl}
		style:left="{cardPos.x}px"
		style:top="{cardPos.y}px"
	>
		<div class="tc-head">
			<span class="tc-title">{step.title}</span>
			<span class="tc-count">{t('tour.step', { n: idx + 1, total: steps.length })}</span>
		</div>
		<p class="tc-body">{step.body}</p>
		<div class="tc-actions">
			<button class="btn linkish" onclick={finish}>{t('tour.skip')}</button>
			<span class="grow"></span>
			{#if idx > 0}
				<button class="btn" onclick={prev}>{t('tour.prev')}</button>
			{/if}
			<button class="btn primary" onclick={next}>
				{idx >= steps.length - 1 ? t('tour.done') : t('tour.next')}
			</button>
		</div>
	</div>
{/if}

<style>
	.spot {
		position: fixed;
		z-index: 200;
		border-radius: var(--radius);
		box-shadow: 0 0 0 9999px rgb(9 12 9 / 0.62);
		pointer-events: none;
		transition:
			left 0.25s ease,
			top 0.25s ease,
			width 0.25s ease,
			height 0.25s ease;
	}

	.tour-card {
		position: fixed;
		z-index: 201;
		width: min(340px, calc(100vw - 20px));
		background: var(--bg-l2);
		border: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
		padding: 14px 16px;
		transition:
			left 0.25s ease,
			top 0.25s ease;
	}

	.tc-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}
	.tc-title {
		font-size: 14px;
		font-weight: 700;
		color: var(--text);
	}
	.tc-count {
		font-size: 11px;
		color: var(--text-faint);
	}
	.tc-body {
		margin: 8px 0 14px;
		font-size: 13px;
		line-height: 1.7;
		color: var(--text-dim);
	}
	.tc-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.grow {
		flex: 1;
	}
	.linkish {
		border-color: transparent;
		background: transparent;
		color: var(--text-faint);
	}
	.linkish:hover {
		color: var(--text);
		background: var(--bg-l3);
	}

	/* 窄屏：卡片吸底横铺 */
	@media (max-width: 768px) {
		.tour-card {
			left: 10px !important;
			right: 10px;
			top: auto !important;
			bottom: calc(10px + env(safe-area-inset-bottom, 0px));
			width: auto;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spot,
		.tour-card {
			transition: none;
		}
	}
</style>
