<script lang="ts">
	// 我的上传列表：包名/状态/文件数/大小/时间 + 删除（上传者删自己的包）
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
</script>

<div class="mask" role="dialog" aria-modal="true" aria-label={t('my.title')}>
	<div class="card">
		<h2>{t('my.title')}</h2>
		<button class="close" aria-label={t('upload.close')} onclick={onclose}>×</button>

		{#if loading}
			<p class="hint">{t('table.loading')}</p>
		{:else if loadFailed}
			<p class="hint">{t('error.load')}</p>
			<button class="btn" onclick={() => void load()}>{t('action.retry')}</button>
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
							class="del"
							disabled={deletingId === p.id}
							onclick={() => void remove(p)}
						>
							{t('my.delete')}
						</button>
					</div>
				{/each}
			</div>
			{#if notice}
				<p class="notice">{notice} <button class="linklike" onclick={() => location.reload()}>刷新</button></p>
			{/if}
		{/if}
	</div>
</div>

<style>
	.mask {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(9 12 9 / 0.62);
		backdrop-filter: blur(4px);
	}

	.card {
		position: relative;
		width: min(560px, calc(100vw - 40px));
		max-height: 80vh;
		overflow: auto;
		background: var(--bg-l2);
		border: 1px solid color-mix(in srgb, var(--bg-l3) 55%, transparent);
		border-radius: var(--radius-lg);
		padding: 22px 24px;
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	.close {
		position: absolute;
		top: 10px;
		right: 12px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 20px;
		cursor: pointer;
	}
	.close:hover {
		color: var(--text);
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

	.del {
		flex: none;
		padding: 4px 12px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-size: 12px;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease,
			border-color 0.15s ease;
	}
	.del:hover {
		border-color: var(--accent-pink);
		color: var(--accent-pink);
	}
	.del:disabled {
		opacity: 0.5;
		cursor: default;
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

	.btn {
		margin-top: 8px;
		padding: 4px 14px;
		border: 1px solid transparent;
		border-radius: var(--radius);
		background: transparent;
		color: var(--accent-bright);
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.btn:hover {
		background: var(--bg-l3);
	}
</style>
