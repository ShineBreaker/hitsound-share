<script lang="ts">
// 连接设置：配置 API 服务器地址（跨源静态部署 / Tauri 桌面）与站点访问密码。
// 顶栏齿轮按「桌面模式或已配置地址」显示（api-base 的 showConnectionEntry）——同源
// 网页版用不到；对可见用户而言连接配置仍与上传能力正交，uploadEnabled=false 时
// 跨源/桌面用户恰恰最需要它。「测试并保存」成功后整页 reload（换源后整树状态重建，最简
// 可靠）；失败回显原因并回滚连接改动，不留半套状态在 localStorage 打死地址
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { fetchConfig, unlockSite } from '$lib/api';
	import {
		clearConnection,
		getApiBase,
		getGateToken,
		setApiBase,
		setGateToken
	} from '$lib/api-base.svelte';

	interface Props {
		onclose: () => void;
		/** 当前连接的门锁定状态（/api/config 的 gate.locked）：密码框初始显隐 */
		gateLocked: boolean;
	}
	let { onclose, gateLocked }: Props = $props();

	let baseInput = $state(getApiBase());
	let pw = $state('');
	let busy = $state(false);
	let err = $state<'' | 'badUrl' | 'unreachable' | 'wrongPassword'>('');
	let savedNotice = $state(false);
	let gateRequired = $state(gateLocked);
	const connected = getApiBase() !== ''; // 断开钮显隐；保存/断开后必然整页刷新，无需追踪更新
	let baseEl = $state<HTMLInputElement | undefined>();
	let pwEl = $state<HTMLInputElement | undefined>();

	onMount(() => {
		// 打开即聚焦地址框；Esc 关闭对话框
		baseEl?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	/** 保存失败回滚到打开对话框时的连接状态（半套状态持久化会让下次 reload 打到死地址） */
	function restore(prevBase: string, prevToken: string | null): void {
		clearConnection();
		if (prevBase) setApiBase(prevBase);
		if (prevToken) setGateToken(prevToken);
	}

	/** 已保存提示可见片刻后整页刷新 */
	function finish(): void {
		savedNotice = true;
		setTimeout(() => location.reload(), 600);
	}

	async function save(): Promise<void> {
		if (busy || savedNotice) return;
		busy = true;
		err = '';
		const raw = baseInput.trim();
		const prevBase = getApiBase();
		const prevToken = getGateToken();
		if (!raw) {
			// 留空 = 回到同源当前站点
			clearConnection();
			finish();
			return;
		}
		try {
			setApiBase(raw);
		} catch {
			err = 'badUrl';
			busy = false;
			return;
		}
		let locked = false;
		try {
			locked = (await fetchConfig()).gate.locked;
		} catch {
			err = 'unreachable';
			restore(prevBase, prevToken);
			busy = false;
			return;
		}
		gateRequired = locked;
		if (locked) {
			if (!pw) {
				// 门锁着但密码还没输：亮出密码框等输入，不算失败
				busy = false;
				pwEl?.focus();
				return;
			}
			try {
				await unlockSite(pw);
			} catch (e) {
				err = (e as Error).message === 'wrong_password' ? 'wrongPassword' : 'unreachable';
				restore(prevBase, prevToken);
				busy = false;
				return;
			}
		}
		finish();
	}

	function disconnect(): void {
		if (busy || savedNotice) return;
		clearConnection();
		location.reload();
	}
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('conn.title')}>
	<div class="dialog-card card">
		<h2>{t('conn.title')}</h2>
		<button class="dialog-close" aria-label={t('upload.close')} onclick={onclose}>×</button>

		<form
			class="body"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<label class="field" for="conn-base">{t('conn.serverUrl')}</label>
			<input
				id="conn-base"
				bind:this={baseEl}
				bind:value={baseInput}
				type="text"
				inputmode="url"
				placeholder={t('conn.serverUrlHint')}
				spellcheck="false"
				autocomplete="off"
				disabled={busy || savedNotice}
			/>

			{#if gateRequired}
				<label class="field" for="conn-pw">{t('conn.sitePassword')}</label>
				<input
					id="conn-pw"
					bind:this={pwEl}
					bind:value={pw}
					type="password"
					maxlength="100"
					autocomplete="current-password"
					disabled={busy || savedNotice}
				/>
			{/if}

			{#if err}
				<p class="msg err" role="alert">
					{err === 'badUrl'
						? t('conn.badUrl')
						: err === 'unreachable'
							? t('conn.unreachable')
							: t('conn.wrongPassword')}
				</p>
			{:else if savedNotice}
				<p class="msg ok">{t('conn.saved')}</p>
			{/if}

			<div class="row">
				<button class="btn primary" type="submit" disabled={busy || savedNotice}>
					{t('conn.testAndSave')}
				</button>
				{#if connected}
					<button class="btn" type="button" onclick={disconnect} disabled={busy || savedNotice}>
						{t('conn.disconnect')}
					</button>
				{/if}
			</div>
		</form>
	</div>
</div>

<style>
	.body {
		display: flex;
		flex-direction: column;
		margin-top: 14px;
		min-width: 320px;
	}

	.field {
		margin: 10px 0 6px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 1.5px;
		color: var(--text-faint);
	}

	input {
		padding: 8px 10px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 14px;
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.msg {
		margin: 12px 0 0;
		font-size: 13px;
	}
	.msg.err {
		color: var(--accent-pink);
	}
	.msg.ok {
		color: var(--accent-bright);
	}

	.row {
		display: flex;
		gap: 8px;
		margin-top: 16px;
	}

	@media (max-width: 480px) {
		.body {
			min-width: 0;
			width: min(320px, calc(100vw - 90px));
		}
	}
</style>
