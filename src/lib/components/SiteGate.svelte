<script lang="ts">
	// 站点访问密码门：全屏遮罩盖住整站（z 高于对话框），解锁成功后由布局层整页刷新重载数据。
	// 出现在 /api/config 返回 gate.locked = true 时（数据请求此刻全部 401 site_locked）
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { unlockSite } from '$lib/api';

	let { onunlock }: { onunlock: () => void } = $props();

	let pw = $state('');
	let busy = $state(false);
	let err = $state<'wrong' | 'rate' | 'failed' | ''>('');
	let inputEl = $state<HTMLInputElement | undefined>();

	onMount(() => inputEl?.focus());

	async function submit(): Promise<void> {
		if (busy || pw === '') return;
		busy = true;
		err = '';
		try {
			await unlockSite(pw);
			onunlock();
		} catch (e) {
			const msg = (e as Error).message;
			err = msg === 'wrong_password' ? 'wrong' : msg === 'too_many_attempts' ? 'rate' : 'failed';
		} finally {
			busy = false;
		}
	}
</script>

<div class="gate-mask" role="dialog" aria-modal="true" aria-label={t('gate.title')}>
	<div class="gate-card">
		<span class="logo" aria-hidden="true"></span>
		<h1>{t('gate.title')}</h1>
		<p class="hint">{t('gate.hint')}</p>
		<form
			class="row"
			onsubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<input
				bind:this={inputEl}
				bind:value={pw}
				type="password"
				placeholder={t('gate.placeholder')}
				maxlength="100"
				autocomplete="current-password"
				disabled={busy}
			/>
			<button class="btn primary" type="submit" disabled={busy || pw === ''}>
				{t('gate.unlock')}
			</button>
		</form>
		{#if err === 'wrong'}
			<p class="err-text">{t('gate.wrong')}</p>
		{:else if err === 'rate'}
			<p class="err-text">{t('gate.rate')}</p>
		{:else if err === 'failed'}
			<p class="err-text">{t('gate.failed')}</p>
		{/if}
	</div>
</div>

<style>
	/* 全站遮罩：层级高于对话框（100）与右下角悬浮件 */
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

	/* 品牌标记：顶栏 logo 同款（薄荷圆环 + 粉点） */
	.logo {
		display: inline-block;
		width: 34px;
		height: 34px;
		border: 5px solid var(--accent);
		border-radius: 50%;
		background: radial-gradient(circle at center, var(--accent-pink) 0 4px, transparent 4px);
	}

	h1 {
		margin: 14px 0 6px;
		font-size: 18px;
		color: var(--text);
	}

	.hint {
		margin: 0 0 18px;
		color: var(--text-faint);
		font-size: 13px;
	}

	.row {
		display: flex;
		gap: 8px;
	}
	.row input {
		flex: 1;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 14px;
	}
	.row input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.err-text {
		margin: 12px 0 0;
		color: var(--accent-pink);
		font-size: 13px;
	}
</style>
