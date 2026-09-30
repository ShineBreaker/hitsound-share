<script lang="ts">
	// 管理员面板：站点访问密码维护（全体管理员）+ 管理员名单（仅超级管理员）。
	// 名单存 users.is_admin，撤权即时生效；访问密码存 D1 settings，改完全站已解锁会话作废
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { fetchAdmins, addAdmin, removeAdmin, setSitePassword, type AdminRow } from '$lib/api';

	interface Props {
		onclose: () => void;
		/** 当前登录者是否超级管理员：名单区块的显示与维护权限 */
		isSuperAdmin?: boolean;
		/** 当前登录者 osu ID：命中名单行时标「超级」徽章（其实际权限来自环境变量） */
		meOsuId?: number;
	}
	let { onclose, isSuperAdmin = false, meOsuId }: Props = $props();

	let admins = $state<AdminRow[]>([]);
	let loading = $state(true);
	let loadFailed = $state(false);
	let input = $state('');
	let busy = $state(false);
	let notice = $state('');
	let err = $state('');

	async function load(): Promise<void> {
		loading = true;
		loadFailed = false;
		try {
			admins = (await fetchAdmins()).admins;
		} catch {
			loadFailed = true;
		} finally {
			loading = false;
		}
	}

	async function add(): Promise<void> {
		const user = input.trim();
		if (!user || busy) return;
		busy = true;
		notice = '';
		err = '';
		try {
			const { admin } = await addAdmin(user);
			if (!admins.some((a) => a.osu_id === admin.osu_id)) {
				admins = [...admins, admin].sort((a, b) =>
					a.username.localeCompare(b.username, 'zh-Hans-CN')
				);
			}
			input = '';
			notice = t('admin.added', { name: admin.username });
		} catch (e) {
			err = (e as Error).message === 'user_not_found' ? t('admin.userNotFound') : t('admin.failed');
		} finally {
			busy = false;
		}
	}

	async function remove(a: AdminRow): Promise<void> {
		if (busy || !window.confirm(t('admin.confirmRemove', { name: a.username }))) return;
		busy = true;
		notice = '';
		err = '';
		try {
			await removeAdmin(a.osu_id);
			admins = admins.filter((x) => x.osu_id !== a.osu_id);
		} catch {
			err = t('admin.failed');
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		if (isSuperAdmin) void load();
	});

	// 站点访问密码（全体管理员可改；改密者自动获发新解锁 cookie）
	let gatePw = $state('');
	let gateBusy = $state(false);
	let gateNotice = $state('');
	let gateErr = $state('');

	async function saveGate(): Promise<void> {
		if (gateBusy || gatePw === '') return;
		gateBusy = true;
		gateNotice = '';
		gateErr = '';
		try {
			await setSitePassword(gatePw);
			gatePw = '';
			gateNotice = t('admin.gate.changed');
		} catch (e) {
			gateErr = (e as Error).message === 'bad_password' ? t('admin.gate.bad') : t('admin.failed');
		} finally {
			gateBusy = false;
		}
	}

	let cardEl = $state<HTMLElement | undefined>();
	onMount(() => {
		// 打开即聚焦输入框；Esc 关闭对话框
		cardEl?.querySelector<HTMLElement>('input, button, [tabindex]')?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('admin.title')}>
	<div class="dialog-card card" bind:this={cardEl}>
		<h2>{t('admin.title')}</h2>
		<button class="dialog-close" aria-label={t('upload.close')} onclick={onclose}>×</button>

		<section class="gate-sec">
			<h3>{t('admin.gate.title')}</h3>
			<form
				class="addrow"
				onsubmit={(e) => {
					e.preventDefault();
					void saveGate();
				}}
			>
				<input
					bind:value={gatePw}
					type="password"
					placeholder={t('admin.gate.placeholder')}
					maxlength="100"
					autocomplete="new-password"
					disabled={gateBusy}
				/>
				<button class="btn primary" type="submit" disabled={gateBusy || gatePw === ''}>
					{t('admin.gate.save')}
				</button>
			</form>
			{#if gateNotice}<p class="notice">{gateNotice}</p>{/if}
			{#if gateErr}<p class="err-text">{gateErr}</p>{/if}
			<p class="hint">{t('admin.gate.hint')}</p>
		</section>

		{#if isSuperAdmin}
			<section>
				<h3>{t('admin.list.title')}</h3>
				<form
					class="addrow"
					onsubmit={(e) => {
						e.preventDefault();
						void add();
					}}
				>
					<input
						bind:value={input}
						placeholder={t('admin.placeholder')}
						maxlength="100"
						disabled={busy}
					/>
					<button class="btn primary" type="submit" disabled={busy || input.trim() === ''}>
						{t('admin.add')}
					</button>
				</form>

				{#if loading}
					<p class="hint">{t('table.loading')}</p>
				{:else if loadFailed}
					<p class="hint">{t('error.load')}</p>
					<button class="btn load-err" onclick={() => void load()}>{t('action.retry')}</button>
				{:else if admins.length === 0}
					<p class="hint">{t('admin.empty')}</p>
				{:else}
					<div class="list">
						{#each admins as a (a.osu_id)}
							<div class="item">
								<div class="info">
									<span class="name">{a.username}</span>
									<span class="meta">
										#{a.osu_id}
										{#if a.osu_id === meOsuId}
											<span class="badge">{t('admin.superBadge')}</span>
										{/if}
									</span>
								</div>
								<button class="btn danger del" disabled={busy} onclick={() => void remove(a)}>
									{t('admin.remove')}
								</button>
							</div>
						{/each}
					</div>
				{/if}

				{#if notice}<p class="notice">{notice}</p>{/if}
				{#if err}<p class="err-text">{err}</p>{/if}
				<p class="hint foot">{t('admin.superHint')}</p>
			</section>
		{/if}
	</div>
</div>

<style>
	/* 对话框骨架与按钮基元在 app.css（.dialog-* / .btn）；只留本组件差异化样式 */
	.card {
		width: min(480px, calc(100vw - 40px));
		max-height: 80vh;
		overflow: auto;
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	.gate-sec {
		margin-bottom: 18px;
	}

	h3 {
		margin: 0 0 8px;
		font-size: 14px;
		color: var(--text);
	}

	.gate-sec .hint {
		margin: 10px 0 0;
		font-size: 12px;
	}

	.addrow {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}
	.addrow input {
		flex: 1;
		min-width: 0;
		padding: 6px 10px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
	}
	.addrow input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.hint {
		color: var(--text-faint);
		font-size: 13px;
	}
	.hint.foot {
		margin: 14px 0 0;
		font-size: 12px;
	}

	.list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 10px;
		border-radius: var(--radius);
	}
	.item:hover {
		background: var(--bg-l3);
	}

	.info {
		min-width: 0;
	}

	.name {
		display: block;
		color: var(--text);
		font-size: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-faint);
		font-size: 12px;
	}

	.badge {
		padding: 0 8px;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--accent-amber) 22%, transparent);
		color: var(--accent-amber);
		font-size: 11px;
	}

	.del {
		flex: none;
		padding: 4px 12px;
		font-size: 12px;
	}

	.notice {
		margin: 12px 0 0;
		color: var(--accent-bright);
		font-size: 13px;
	}

	.err-text {
		margin: 12px 0 0;
		color: var(--accent-pink);
		font-size: 13px;
	}

	.load-err {
		margin-top: 8px;
		color: var(--accent-bright);
	}
</style>
