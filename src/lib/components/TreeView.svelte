<script lang="ts">
	// 目录树节点：递归渲染（Svelte 5 通过自引用 import 实现递归组件）。
	// 包主/管理员 hover 可见 ✎：行内编辑节点名（大类=包名，小类=文件夹末级段）
	import type { TreeNode } from '$lib/types';
	import { t } from '$lib/i18n';
	import type { Me } from '$lib/api';
	import TreeView from './TreeView.svelte';

	interface Props {
		node: TreeNode;
		depth?: number;
		selected?: string;
		me?: Me;
		editingKey?: string;
		onselect?: (key: string) => void;
		/** 提交改名（key + 新末级名），返回是否成功；失败保持编辑态 */
		onsubmit?: (key: string, name: string) => Promise<boolean>;
	}
	let {
		node,
		depth = 0,
		selected = '',
		me = { loggedIn: false },
		editingKey = $bindable(''),
		onselect,
		onsubmit
	}: Props = $props();

	// 默认收缩到最小（只显示顶层包名），由用户点箭头/名字逐级展开
	let open = $state(false);
	const hasChildren = $derived(node.children.length > 0);
	const editing = $derived(editingKey === node.key);
	const canEdit = $derived(
		Boolean(me.loggedIn && (me.isAdmin || (me.osuId != null && me.osuId === node.ownerOsuId)))
	);
	let editValue = $state('');
	let submitting = $state(false);
	let failed = $state(false); // 提交失败：红框短暂提示，保持编辑态不丢输入

	function startEdit(): void {
		editValue = node.name;
		failed = false;
		editingKey = node.key; // bind:editingKey 上提（同名编辑互斥）
	}

	async function submitEdit(): Promise<void> {
		const name = editValue.trim();
		if (submitting) return;
		if (!name || name === node.name) {
			editingKey = '';
			return;
		}
		submitting = true;
		const ok = (await onsubmit?.(node.key, name)) ?? true;
		submitting = false;
		if (ok) editingKey = '';
		else {
			failed = true;
			setTimeout(() => (failed = false), 1500);
		}
	}
</script>

<div class="row" style:padding-left={`${depth * 14 + 6}px`}>
	{#if hasChildren}
		<button
			class="caret"
			class:open
			aria-label={open ? t('tree.collapse') : t('tree.expand')}
			onclick={() => (open = !open)}
		>
			▸
		</button>
	{:else}
		<span class="caret spacer"></span>
	{/if}
	{#if editing}
		<input
			class="edit"
			class:failed
			bind:value={editValue}
			disabled={submitting}
			maxlength="100"
			title={failed ? t('rename.failed') : undefined}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => {
				if (e.key === 'Enter') void submitEdit();
				else if (e.key === 'Escape') editingKey = '';
			}}
			onblur={() => {
				// blur 即放弃（点击他处/Tab）；Enter 提交，Esc 取消
				if (editingKey === node.key) editingKey = '';
			}}
		/>
	{:else}
		<button
			class="label"
			class:pkg={node.isPackage}
			class:active={selected === node.key}
			onclick={() => {
				// 名字是更大的点击目标：点收起中的节点顺带展开；收起只走箭头，避免反复横跳
				if (hasChildren && !open) open = true;
				onselect?.(node.key);
			}}
		>
			{node.name}
		</button>
		{#if canEdit}
			<button class="rename" title={t('action.rename')} aria-label={t('action.rename')} onclick={startEdit}>
				✎
			</button>
		{/if}
	{/if}
</div>

{#if hasChildren && open}
	{#each node.children as child (child.key)}
		<!-- bind 透传 editingKey：嵌套子树共用同一编辑互斥状态（无 bind 时子树是独立本地态） -->
		<TreeView
			node={child}
			depth={depth + 1}
			{selected}
			{me}
			bind:editingKey
			{onselect}
			{onsubmit}
		/>
	{/each}
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 100%; /* 横向溢出时整行保持可点 */
	}

	.caret {
		flex: none;
		width: 22px;
		height: 22px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 12px;
		cursor: pointer;
		border-radius: var(--radius);
		transition: transform 0.15s ease;
	}
	.caret:hover {
		background: var(--bg-l3);
		color: var(--accent-bright);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.caret.spacer {
		cursor: default;
	}

	.label {
		flex: 1;
		min-width: 0;
		text-align: left;
		border: none;
		background: transparent;
		color: var(--text-dim);
		font-size: 14px;
		padding: 5px 10px;
		border-radius: var(--radius);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.label:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	/* 选中节点：薄荷填充 + 深色文字（编辑器选中态） */
	.label.active {
		background: var(--accent);
		color: var(--on-accent);
	}
	/* 包名（顶层节点）加粗 + 亮薄荷 */
	.label.pkg {
		font-weight: 600;
		color: var(--accent-bright);
	}
	.label.pkg.active {
		color: var(--on-accent);
	}

	/* 行内改名输入：与 label 同高，占满剩余宽度 */
	.edit {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		padding: 4px 8px;
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--bg-inset);
		color: var(--text);
		font-family: inherit;
		font-size: 14px;
	}
	.edit:focus {
		outline: none;
	}
	.edit:disabled {
		opacity: 0.6;
	}
	/* 提交失败：红框 1.5s 提示（保持编辑态，输入不丢） */
	.edit.failed {
		border-color: var(--accent-pink);
	}

	/* ✎ 按钮：默认隐藏，行 hover 或自身 focus 时浮现 */
	.rename {
		flex: none;
		width: 22px;
		height: 22px;
		padding: 0;
		display: none;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 11px;
		cursor: pointer;
		border-radius: var(--radius);
	}
	.row:hover .rename,
	.rename:focus-visible {
		display: inline-flex;
	}
	/* 触屏没有 hover：常显（小屏触控目标放宽到 32px） */
	@media (hover: none) {
		.rename {
			display: inline-flex;
			width: 32px;
			height: 32px;
			font-size: 13px;
		}
	}
	.rename:hover {
		background: var(--bg-l3);
		color: var(--accent-bright);
	}
</style>
