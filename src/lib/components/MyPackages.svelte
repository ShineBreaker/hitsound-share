<script lang="ts">
	// 我的上传列表：包名/状态/文件数/大小/时间 + 删除（上传者删自己的包）
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';

	interface Props {
		onclose: () => void;
	}
	let { onclose }: Props = $props();

	interface MyPackage {
		id: string;
		name: string;
		status: string;
		created_at: string;
		file_count: number;
		size_bytes: number;
		logical_size: number;
	}

	let packages = $state<MyPackage[]>([]);
	let loading = $state(true);
	let loadFailed = $state(false);
	let deletingId = $state<string | null>(null);
	let notice = $state('');

	async function load(): Promise<void> {
		loading = true;
		loadFailed = false;
		try {
			const res = await fetch('/api/my/packages');
			if (!res.ok) throw new Error();
			packages = ((await res.json()) as { packages: MyPackage[] }).packages;
		} catch {
			loadFailed = true;
		} finally {
			loading = false;
		}
	}

	async function remove(pkg: MyPackage): Promise<void> {
		if (!window.confirm(t('my.confirmDelete', { name: pkg.name }))) return;
		deletingId = pkg.id;
		notice = '';
		try {
			const res = await fetch(`/api/package/${encodeURIComponent(pkg.id)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			packages = packages.filter((p) => p.id !== pkg.id);
			notice = t('my.deleted');
		} catch {
			notice = t('my.deleteFailed');
		} finally {
			deletingId = null;
		}
	}

	function fmtSize(bytes: number): string {
		if (bytes <= 0) return '—';
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	// 打开即加载
	$effect(() => {
		void load();
	});

	let cardEl = $state<HTMLElement | undefined>();
	onMount(() => {
		// 打开即聚焦首个控件；Esc 关闭对话框
		cardEl?.querySelector<HTMLElement>('input, select, button, [tabindex]')?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('my.title')}>
	<div class="dialog-card card" bind:this={cardEl}>
		<h2>{t('my.title')}</h2>
		<button class="dialog-close" aria-label={t('upload.close')} onclick={onclose}>×</button>

		{#if loading}
			<p class="hint">{t('table.loading')}</p>
		{:else if loadFailed}
			<p class="hint">{t('error.load')}</p>
			<button class="btn load-err" onclick={() => void load()}>{t('action.retry')}</button>
		{:else if packages.length === 0}
			<p class="hint">{t('my.empty')}</p>
		{:else}
			<div class="list">
				{#each packages as p (p.id)}
					<div class="item">
						<div class="info">
							<span class="name" title={p.name}>{p.name}</span>
							<span class="meta">
								<span class="badge" class:pending={p.status !== 'visible'}>
									{p.status === 'visible' ? t('my.status.visible') : t('my.status.pending')}
								</span>
								{t('my.fileCount', { count: p.file_count })}
								· {fmtSize(p.logical_size)}
								· {p.created_at}
							</span>
						</div>
						<button
							class="btn danger del"
							disabled={deletingId === p.id}
							onclick={() => void remove(p)}
						>
							{t('my.delete')}
						</button>
					</div>
				{/each}
			</div>
			{#if notice}
				<p class="notice">{notice} <button class="linklike" onclick={() => location.reload()}>{t('my.refresh')}</button></p>
			{/if}
		{/if}
	</div>
</div>

<style>
	/* 对话框骨架与按钮基元在 app.css（.dialog-* / .btn）；只留本组件差异化样式 */
	.card {
		width: min(560px, calc(100vw - 40px));
		max-height: 80vh;
		overflow: auto;
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	.hint {
		color: var(--text-faint);
		font-size: 13px;
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
		transition: background 0.15s ease;
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
		white-space: nowrap;
	}

	.badge {
		padding: 0 8px;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--accent) 22%, transparent);
		color: var(--accent-bright);
		font-size: 11px;
	}
	.badge.pending {
		background: color-mix(in srgb, var(--accent-amber) 22%, transparent);
		color: var(--accent-amber);
	}

	/* 行内删除钮：比正文按钮小一号 */
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

	.linklike {
		border: none;
		background: transparent;
		color: var(--accent-bright);
		text-decoration: underline;
		cursor: pointer;
		font-size: 13px;
		padding: 0;
	}

	/* 重试按钮：薄荷字 + 上间距 */
	.load-err {
		margin-top: 8px;
		color: var(--accent-bright);
	}
</style>
