<script lang="ts">
	// 目录树节点：递归渲染（Svelte 5 通过自引用 import 实现递归组件）
	import type { TreeNode } from '$lib/types';
	import TreeView from './TreeView.svelte';

	interface Props {
		node: TreeNode;
		depth?: number;
		selected?: string;
		onselect?: (key: string) => void;
	}
	let { node, depth = 0, selected = '', onselect }: Props = $props();

	// 文件夹默认展开；点箭头折叠
	let open = $state(true);
	const hasChildren = $derived(node.children.length > 0);
</script>

<div class="row" style:padding-left={`${depth * 14 + 6}px`}>
	{#if hasChildren}
		<button
			class="caret"
			class:open
			aria-label={open ? '折叠' : '展开'}
			onclick={() => (open = !open)}
		>
			▸
		</button>
	{:else}
		<span class="caret spacer"></span>
	{/if}
	<button
		class="label"
		class:pkg={node.isPackage}
		class:active={selected === node.key}
		onclick={() => onselect?.(node.key)}
	>
		{node.name}
	</button>
</div>

{#if hasChildren && open}
	{#each node.children as child (child.key)}
		<TreeView node={child} depth={depth + 1} {selected} {onselect} />
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
		width: 18px;
		height: 18px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 10px;
		cursor: pointer;
		border-radius: var(--radius);
		transition: transform 0.15s ease;
	}
	.caret:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	.caret.open {
		transform: rotate(90deg);
	}
	.caret.spacer {
		cursor: default;
	}

	.label {
		flex: 1;
		text-align: left;
		border: none;
		background: transparent;
		color: var(--text-dim);
		font-size: 13px;
		padding: 3px 8px;
		border-radius: var(--radius);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.label:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	.label.active {
		background: var(--accent);
		color: var(--text);
	}
	/* 包名（顶层节点）加粗 + 亮紫 */
	.label.pkg {
		font-weight: 600;
		color: var(--accent-bright);
	}
	.label.pkg.active {
		color: var(--text);
	}
</style>
