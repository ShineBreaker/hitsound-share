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
	import { fetchConfig, fetchMe, exchangeAuthCode, type Me } from '$lib/api';
	import { apiFetch, loginUrl, setSessionToken, needsDesktopSetup } from '$lib/api-base.svelte';
	import UploadDialog from '$lib/components/UploadDialog.svelte';
	import MyPackages from '$lib/components/MyPackages.svelte';
	import AdminPanel from '$lib/components/AdminPanel.svelte';
	import SiteGate from '$lib/components/SiteGate.svelte';
	import ConnectionSettings from '$lib/components/ConnectionSettings.svelte';
	import HelpDialog from '$lib/components/HelpDialog.svelte';
	import Tour from '$lib/components/Tour.svelte';
	import { ui } from '$lib/ui.svelte';

	let { children } = $props();

	// 登录/上传入口按 /api/config 显隐：上传链路凭证未配齐时隐藏（浏览/试听/下载不受影响）。
	// 预渲染 HTML 中初始为 false（隐藏），客户端拉到配置后再显形，避免烘错部署期状态
	let uploadEnabled = $state(false);
	let me = $state<Me | null>(null);
	let showUpload = $state(false);
	let showMy = $state(false);
	let showAdmin = $state(false); // 管理员面板（访问密码 + 超管的名单维护）
	let gateLocked = $state(false); // 站点访问密码门：未解锁时全站遮罩，数据 API 均 401
	let showConn = $state(false); // 连接设置对话框（齿轮入口；桌面首启引导也会打开）
	let desktopSetup = $state(false); // 桌面首启引导遮罩：Tauri 且未配 API base

	onMount(() => {
		desktopSetup = needsDesktopSetup();
		// ? 键（Shift+/）打开帮助：不在输入框、无其他模态时生效
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== '?' || e.ctrlKey || e.altKey || e.metaKey) return;
			const tgt = e.target as HTMLElement | null;
			if (tgt?.closest('input, textarea, select, [contenteditable="true"]')) return;
			if (document.querySelector('[aria-modal="true"]')) return; // 已有模态（含帮助自身）不叠开
			ui.helpOpen = true;
		};
		window.addEventListener('keydown', onKey);
		// 配置与登录态是独立异步流程，不阻塞监听注册
		void (async () => {
			// OAuth 交付码落地（登录 code 交付轨，桌面/跨源同用）：换会话 token 后清参数
			// 防刷新重放；失败静默（保持未登录）。同源登录无 code，此分支不触发
			const code = new URLSearchParams(location.search).get('hs_code');
			if (code) {
				await exchangeAuthCode(code);
				const params = new URLSearchParams(location.search);
				params.delete('hs_code');
				const rest = params.toString();
				history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
			}
			try {
				const cfg = await fetchConfig();
				uploadEnabled = cfg.uploadEnabled;
				gateLocked = cfg.gate.locked;
			} catch {
				// 配置拉取失败按未启用处理
			}
			if (gateLocked || !uploadEnabled) return; // 未解锁时登录态请求也会 401，解锁后整页刷新重载
			const data = await fetchMe();
			if (data.loggedIn && data.username) me = data;
		})();
		return () => window.removeEventListener('keydown', onKey);
	});

	async function logout(): Promise<void> {
		// 会话 token 轨与 cookie 并存：服务端清 cookie 的同时本地清 token（防换人登录后
		// 旧 token 仍以 header 轨复活旧会话——桌面端无 cookie，全靠这一清）
		setSessionToken(null);
		await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => null);
		location.reload();
	}

	/** 未登录点上传 → 先走 OAuth 登录（跨源时 loginUrl 带 hs_origin 供 state 编码前端来源） */
	function onUploadClick(): void {
		if (!me) {
			location.href = loginUrl();
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
					{#if me.isSuperAdmin || me.isAdmin}
						<button class="linklike" type="button" onclick={() => (showAdmin = true)}>
							{t('app.admin')}
						</button>
					{/if}
					<button class="linklike" type="button" onclick={() => void logout()}>
						{t('auth.logout')}
					</button>
				{:else}
					<a class="btn lg" href={loginUrl()}>{t('app.login')}</a>
				{/if}
				<button
					class="btn primary lg"
					type="button"
					data-tour="upload"
					onclick={onUploadClick}
				>
					{t('app.upload')}
				</button>
			{/if}
			<!-- 连接设置入口无条件显示（连接配置与上传能力正交：后端未配齐上传变量时，
			     跨源 Web / 桌面用户恰恰最需要配置服务器地址） -->
			<button
				class="help-btn gear-btn"
				type="button"
				title={t('conn.title')}
				aria-label={t('conn.title')}
				onclick={() => (showConn = true)}
			>
				<!-- 齿轮图标：lucide settings（ISC） -->
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path
						d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
					/>
					<circle cx="12" cy="12" r="3" />
				</svg>
			</button>
			<!-- 帮助入口始终显示（上传未启用时也不例外） -->
			<button
				class="help-btn"
				type="button"
				data-tour="help"
				title={t('app.help')}
				aria-label={t('app.help')}
				onclick={() => (ui.helpOpen = true)}
			>
				?
			</button>
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
	<UploadDialog
		onclose={() => (showUpload = false)}
		username={me?.username ?? ''}
		isAdmin={me?.isAdmin ?? false}
	/>
{/if}
{#if showMy}
	<MyPackages onclose={() => (showMy = false)} />
{/if}
{#if showAdmin}
	<AdminPanel
		onclose={() => (showAdmin = false)}
		isSuperAdmin={me?.isSuperAdmin ?? false}
		meOsuId={me?.osuId}
	/>
{/if}
{#if ui.helpOpen}
	<HelpDialog {uploadEnabled} onclose={() => (ui.helpOpen = false)} />
{/if}
{#if showConn}
	<ConnectionSettings onclose={() => (showConn = false)} {gateLocked} />
{/if}
<Tour />

<!-- 站点访问密码门：盖住整站（含所有对话框），解锁成功后整页刷新重载数据 -->
{#if gateLocked}
	<SiteGate onunlock={() => location.reload()} />
{/if}

<!-- 桌面首启引导：Tauri 环境且未配服务器地址（自定义协议源下没有同源后端可打）。
     打开连接设置时暂时让位（z 同为 200，对话框要可操作）；保存成功后整页刷新，遮罩不再回来 -->
{#if desktopSetup && !showConn}
	<div class="gate-mask" role="dialog" aria-modal="true" aria-label={t('conn.desktopRequired')}>
		<div class="gate-card">
			<span class="logo" aria-hidden="true"></span>
			<h1>{t('conn.desktopRequired')}</h1>
			<p class="hint">{t('conn.desktopHint')}</p>
			<button class="btn primary" type="button" onclick={() => (showConn = true)}>
				{t('conn.title')}
			</button>
		</div>
	</div>
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
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
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

	/* 帮助圆钮：与 GitHub 钮同款描边圆形 */
	.help-btn {
		width: 28px;
		height: 28px;
		flex: none;
		border-radius: 50%;
		border: 1px solid var(--bg-l3);
		background: transparent;
		color: var(--text-faint);
		font-size: 14px;
		font-weight: 700;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.help-btn:hover {
		color: var(--accent-bright);
		border-color: var(--accent);
	}

	/* 齿轮钮复用帮助圆钮基形，图标居中缩放 */
	.gear-btn svg {
		width: 15px;
		height: 15px;
	}

	/* 桌面首启引导遮罩：SiteGate 的视觉模式（同 z 层 200，卡片居中 + 模糊底） */
	.gate-mask {
		position: fixed;
		inset: 0;
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg-l1) 92%, transparent);
		backdrop-filter: blur(6px);
	}

	.gate-card {
		width: min(360px, calc(100vw - 40px));
		padding: 32px 28px;
		text-align: center;
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius-lg);
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.4);
	}

	.gate-card .logo {
		display: inline-block;
		width: 34px;
		height: 34px;
		border: 5px solid var(--accent);
		border-radius: 50%;
		background: radial-gradient(circle at center, var(--accent-pink) 0 4px, transparent 4px);
	}

	.gate-card h1 {
		margin: 14px 0 6px;
		font-size: 18px;
		color: var(--text);
	}

	.gate-card .hint {
		margin: 0 0 18px;
		color: var(--text-faint);
		font-size: 13px;
	}

	/* ============ 窄屏：藏标语、收紧顶栏 ============ */
	@media (max-width: 768px) {
		.topbar {
			padding: 0 12px;
			height: 48px;
		}
		.tagline {
			display: none;
		}
		.title {
			font-size: 15px;
		}
		.actions :global(.btn.lg) {
			padding: 4px 12px;
			font-size: 13px;
		}
	}
</style>
