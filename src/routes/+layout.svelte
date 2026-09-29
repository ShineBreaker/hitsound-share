<script lang="ts">
	// 全局布局壳：顶栏（站名 + 登录/上传）+ 内容区
	// Exo 2 走 @fontsource（npm 内自托管 woff2，构建期打包进产物，无外链 CDN）
	import '@fontsource/exo-2/400.css';
	import '@fontsource/exo-2/500.css';
	import '@fontsource/exo-2/600.css';
	import '@fontsource/exo-2/700.css';
	import '../app.css';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { fetchConfig } from '$lib/api';

	let { children } = $props();

	// 登录/上传入口按 /api/config 显隐：OSU OAuth 凭证未配置时隐藏（浏览/试听/下载不受影响）。
	// 预渲染 HTML 中初始为 false（隐藏），客户端拉到配置后再显形，避免烘错部署期状态
	let uploadEnabled = $state(false);
	onMount(async () => {
		try {
			uploadEnabled = (await fetchConfig()).uploadEnabled;
		} catch {
			// 配置拉取失败按未启用处理
		}
	});
</script>

<div class="shell">
	<header class="topbar">
		<div class="brand">
			<span class="logo" aria-hidden="true"></span>
			<span class="title">{t('app.title')}</span>
			<span class="tagline">{t('app.tagline')}</span>
		</div>
		<div class="actions">
			{#if uploadEnabled}
				<button class="btn" type="button">{t('app.login')}</button>
				<button class="btn primary" type="button">{t('app.upload')}</button>
			{/if}
		</div>
	</header>

	<main class="content">
		{@render children()}
	</main>
</div>

<style>
	.shell {
		height: 100%;
		display: flex;
		flex-direction: column;
	}

	.topbar {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 16px;
		height: 52px;
		background: var(--bg-l2);
		border-bottom: 1px solid var(--bg-l3);
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}

	/* 品牌标记：紫色圆环 + 粉色圆点（favicon 同款） */
	.logo {
		align-self: center;
		width: 22px;
		height: 22px;
		flex: none;
		border: 4px solid var(--accent);
		border-radius: 50%;
		background:
			radial-gradient(circle at center, var(--accent-pink) 0 3px, transparent 3px);
	}

	.title {
		font-size: 17px;
		font-weight: 700;
		color: var(--text);
		white-space: nowrap;
	}

	.tagline {
		font-size: 12px;
		color: var(--text-faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	.btn {
		padding: 6px 16px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
	}
	.btn:hover {
		background: var(--bg-l3);
		color: var(--text);
	}

	.btn.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	.btn.primary:hover {
		background: var(--accent-deep);
		border-color: var(--accent-deep);
	}

	.content {
		flex: 1;
		min-height: 0; /* 允许内部滚动 */
	}
</style>
