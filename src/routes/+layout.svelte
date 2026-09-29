<script lang="ts">
	// 全局布局壳：顶栏（站名 + 登录态/上传/我的上传）+ 内容区
	// Comfortaa 走 @fontsource（npm 内自托管 woff2，构建期打包进产物，无外链 CDN）；
	// 圆润几何无衬线，作为 osu! 商业字体 Torus 的 OFL 开源替代
	import '@fontsource/comfortaa/400.css';
	import '@fontsource/comfortaa/500.css';
	import '@fontsource/comfortaa/600.css';
	import '@fontsource/comfortaa/700.css';
	import '../app.css';
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { fetchConfig, fetchMe } from '$lib/api';
	import UploadDialog from '$lib/components/UploadDialog.svelte';
	import MyPackages from '$lib/components/MyPackages.svelte';

	let { children } = $props();

	// 登录/上传入口按 /api/config 显隐：上传链路凭证未配齐时隐藏（浏览/试听/下载不受影响）。
	// 预渲染 HTML 中初始为 false（隐藏），客户端拉到配置后再显形，避免烘错部署期状态
	let uploadEnabled = $state(false);
	let me = $state<{ username: string } | null>(null);
	let showUpload = $state(false);
	let showMy = $state(false);

	onMount(async () => {
		try {
			uploadEnabled = (await fetchConfig()).uploadEnabled;
		} catch {
			// 配置拉取失败按未启用处理
		}
		if (!uploadEnabled) return;
		const data = await fetchMe();
		if (data.loggedIn && data.username) me = { username: data.username };
	});

	async function logout(): Promise<void> {
		await fetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
		location.reload();
	}

	/** 未登录点上传 → 先走 OAuth 登录 */
	function onUploadClick(): void {
		if (!me) {
			location.href = '/api/auth/login';
			return;
		}
		showUpload = true;
	}
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
				{#if me}
					<button class="user" type="button" onclick={() => (showMy = true)} title={me.username}>
						{me.username}
					</button>
					<button class="linklike" type="button" onclick={() => void logout()}>
						{t('auth.logout')}
					</button>
				{:else}
					<a class="btn lg" href="/api/auth/login">{t('app.login')}</a>
				{/if}
				<button class="btn primary lg" type="button" onclick={onUploadClick}>{t('app.upload')}</button>
			{/if}
		</div>
	</header>

	<main class="content">
		{@render children()}
	</main>

	<!-- 右下角 GitHub 直达：反馈 issue 用（外链导航不受 CSP default-src 限制） -->
	<a
		class="gh-fab"
		href="https://github.com/ShineBreaker/hitsound-share/issues/new"
		target="_blank"
		rel="noopener noreferrer"
		aria-label={t('app.github')}
		title={t('app.github')}
	>
		<!-- GitHub Mark（CC-BY-4.0，github.com/logos） -->
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<path
				d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
				0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
				1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
				0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0
				1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0
				3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01
				8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
			/>
		</svg>
	</a>
</div>

{#if showUpload}
	<UploadDialog onclose={() => (showUpload = false)} username={me?.username ?? ''} />
{/if}
{#if showMy}
	<MyPackages onclose={() => (showMy = false)} />
{/if}

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
		padding: 0 18px;
		height: 54px;
		background: var(--bg-l2);
		border-bottom: 1px solid color-mix(in srgb, var(--bg-l3) 70%, transparent);
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
	}

	/* 品牌标记：薄荷圆环 + 粉色圆点（favicon 同款） */
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
		align-items: center;
		gap: 8px;
	}

	/* 按钮基元在 app.css（.btn/.primary/.lg），顶栏不再自带一份 */

	/* 已登录用户名按钮（打开我的上传） */
	.user {
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: none;
		background: transparent;
		color: var(--accent-bright);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		padding: 6px 8px;
		border-radius: var(--radius);
	}
	.user:hover {
		background: var(--bg-l3);
	}

	.linklike {
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 12px;
		cursor: pointer;
		padding: 6px 4px;
	}
	.linklike:hover {
		color: var(--text);
	}

	.content {
		flex: 1;
		min-height: 0; /* 允许内部滚动 */
	}

	/* 右下角 GitHub 反馈圆钮（z-index 低于对话框的 100） */
	.gh-fab {
		position: fixed;
		right: 16px;
		bottom: 16px;
		z-index: 50;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		color: var(--text-faint);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.gh-fab:hover {
		color: var(--accent-bright);
		border-color: var(--accent);
	}
	.gh-fab svg {
		width: 20px;
		height: 20px;
		fill: currentColor;
	}
</style>
