<script module lang="ts">
	// 移动来源模式（页面层持有）：files = 多选所选文件，folder = 树小类整体（pkgId + 全路径）
	export type MoveMode = { kind: 'files' } | { kind: 'folder'; pkgId: string; folderPath: string };
</script>

<script lang="ts">
	// 移动目标选择对话框（纯 UI 壳）：只负责选目标分组/小类并把结果交回页面层 onsubmit
	// （分片调用、清选中、刷树、迁移选中等后续全归页面）；true = 成功关窗，false = 保持开窗
	import { onMount } from 'svelte';
	import { t } from '$lib/i18n';
	import { canManage, type Me, type TreePackage } from '$lib/api';

	interface Props {
		mode: MoveMode;
		/** 候选分组 = 页面已有的树包列表（免重复请求），按管理权过滤后展示 */
		packages: TreePackage[];
		me: Me;
		onclose: () => void;
		onsubmit: (to: { pkgId: string; folderPath: string }) => Promise<boolean>;
	}
	let { mode, packages, me, onclose, onsubmit }: Props = $props();

	let cardEl = $state<HTMLElement | undefined>();
	let submitting = $state(false);

	// 普通用户只见自己的包，管理员见全部（与服务端权限同口径）
	const movable = $derived(packages.filter((p) => canManage(me, p.uploaderOsuId)));

	// 默认目标：小类模式预选来源包（「提升到包根」一键可达——移动钮仅在可管理节点出现，
	// 来源包必在候选里）；文件模式取第一个可管理包。
	// 对话框每次打开都全新挂载，初始快照正是想要的行为，非疏忽：
	// svelte-ignore state_referenced_locally
	const defaultPkgId =
		mode.kind === 'folder' && movable.some((p) => p.id === mode.pkgId)
			? mode.pkgId
			: (movable[0]?.id ?? '');
	let toPkgId = $state(defaultPkgId);
	let toFolder = $state('');

	const toPkg = $derived(packages.find((p) => p.id === toPkgId));
	// 目标小类候选：folders 是全路径列表（'' 为包根占位，由 move.root 选项承担），字典序
	const toFolders = $derived(
		toPkg
			? toPkg.folders
					.filter((f) => f !== '')
					.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
			: []
	);

	// 小类模式：同包同路径选项禁用（移到自己名下无意义；移进自身子树由服务端兜底拒绝）
	function selfTarget(f: string): boolean {
		return mode.kind === 'folder' && toPkgId === mode.pkgId && f === mode.folderPath;
	}

	async function submit(): Promise<void> {
		if (submitting || !toPkgId) return;
		submitting = true;
		const ok = await onsubmit({ pkgId: toPkgId, folderPath: toFolder });
		submitting = false;
		if (ok) onclose();
	}

	onMount(() => {
		// 打开即聚焦首个控件（DESIGN.md 对话框规范）；Esc 关闭，提交中不响应防中断
		cardEl?.querySelector<HTMLElement>('select, button')?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !submitting) onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('move.title')}>
	<div class="dialog-card card" bind:this={cardEl}>
		<h2>{t('move.title')}</h2>

		{#if mode.kind === 'folder'}
			<p class="src" title={mode.folderPath}>{t('tree.moveFolder')}：{mode.folderPath}</p>
		{/if}

		<label class="lbl" for="move-target-pkg">{t('move.targetPkg')}</label>
		<select id="move-target-pkg" class="text" bind:value={toPkgId} onchange={() => (toFolder = '')}>
			{#each movable as p (p.id)}
				<option value={p.id}>{p.name}</option>
			{/each}
		</select>

		<label class="lbl" for="move-target-folder">{t('move.targetFolder')}</label>
		<select id="move-target-folder" class="text" bind:value={toFolder}>
			<option value="">{t('move.root')}</option>
			{#each toFolders as f (f)}
				<option value={f} disabled={selfTarget(f)}>{f}</option>
			{/each}
		</select>

		<div class="row">
			<button class="btn primary" disabled={submitting || !toPkgId} onclick={() => void submit()}>
				{t('move.submit')}
			</button>
			<button class="btn" disabled={submitting} onclick={onclose}>{t('action.cancel')}</button>
		</div>

		<button class="dialog-close" aria-label={t('action.cancel')} disabled={submitting} onclick={onclose}>
			×
		</button>
	</div>
</div>

<style>
	/* 对话框骨架与按钮基元在 app.css（.dialog-* / .btn）；只留本组件差异化样式 */
	.card {
		width: min(420px, calc(100vw - 40px));
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	/* 来源小类全路径（凹陷行；# 空格 & 逗号是常态，title 兜底看全路径） */
	.src {
		color: var(--text-dim);
		font-size: 13px;
		margin: 4px 0 12px;
		padding: 8px 10px;
		border-radius: var(--radius);
		background: var(--bg-inset);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.lbl {
		display: block;
		color: var(--text-faint);
		font-size: 12px;
		margin-bottom: 6px;
	}

	.text {
		width: 100%;
		box-sizing: border-box;
		padding: 7px 10px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
	}
	.text:focus {
		outline: none;
		border-color: var(--accent);
	}

	/* 两个下拉之间的间距（lbl 自带上边距不足） */
	.lbl:not(:first-of-type) {
		margin-top: 12px;
	}

	.row {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}

	/* 对话框内按钮统一大号尺寸（同 UploadDialog） */
	.row .btn {
		padding: 6px 16px;
	}
</style>
