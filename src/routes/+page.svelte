<script lang="ts">
	// 主页：左树（顶层 = 各包 → 包内文件夹层级）+ 右表（选中文件夹的文件）
	// M1 接 mock 数据；M2/M3 换 /api/tree 与 /api/files
	import TreeView from '$lib/components/TreeView.svelte';
	import FileTable from '$lib/components/FileTable.svelte';
	import { MOCK_TREE, filesOfNode } from '$lib/mock';
	import { t } from '$lib/i18n';

	let selected = $state(MOCK_TREE.key);

	// 包根 → folderPath '' 的文件；文件夹 → 精确匹配
	const files = $derived(filesOfNode(selected));
</script>

<div class="browser">
	<aside class="tree-panel">
		<div class="panel-title">{t('tree.title')}</div>
		<nav class="tree">
			<TreeView node={MOCK_TREE} {selected} onselect={(key) => (selected = key)} />
		</nav>
	</aside>

	<section class="files-panel">
		<FileTable {files} />
	</section>
</div>

<style>
	.browser {
		height: 100%;
		display: grid;
		grid-template-columns: 280px 1fr;
		gap: 10px;
		padding: 10px;
	}

	.tree-panel,
	.files-panel {
		min-height: 0; /* grid 子项内部滚动 */
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.panel-title {
		flex: none;
		padding: 10px 14px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 1px;
		color: var(--text-faint);
		border-bottom: 1px solid var(--bg-l3);
	}

	.tree {
		flex: 1;
		overflow: auto;
		padding: 6px;
	}

	.files-panel > :global(.table-wrap) {
		flex: 1;
	}
</style>
