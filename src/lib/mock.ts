// M1 骨架 mock 数据：形态对齐已入库的 lasse 库真实结构
// （顶层文件夹含「#default skin」「hihat, ride etc」这类 # / 空格 / 逗号路径，
//   文件名含空格；M2 换 /api/tree 与 /api/files 后本文件移除）
import type { FileRow, TreeNode } from '$lib/types';

const PACKAGE_ID = 'lasse';
const PACKAGE_NAME = 'hitsounds_lasse_jan2021';

/** 确定性伪随机波形：无需真实音频即可预览波形渲染（正弦包络模拟打击音效） */
function fakePeaks(seed: number, n = 160): number[] {
	const out: number[] = [];
	let x = (seed * 9973 + 7) % 2147483647;
	for (let i = 0; i < n; i++) {
		x = (x * 16807) % 2147483647;
		const env = 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / n);
		out.push(Math.min(1, (0.25 + 0.75 * (x / 2147483647)) * env));
	}
	return out;
}

// [文件夹相对路径, 文件名列表]；含一层嵌套（whistles/long）以验证树的递归层级
const MOCK_ENTRIES: Array<[string, string[]]> = [
	['#default skin', ['normal-hitnormal.wav', 'normal-hitclap.wav', 'soft-hitfinish.wav']],
	['basic hs', ['basic-hitnormal.wav', 'basic-hitclap.wav', 'basic-hitfinish.wav']],
	['bell', ['normal-hitnormal (bell).wav', 'soft-hitclap (bell).wav']],
	['claps-snares', ['normal-hitclap.wav', 'soft-hitclap.wav', 'drum-hitclap.wav']],
	['cymbals-finishes', ['normal-hitfinish.wav', 'soft-hitfinish (cymbal).wav']],
	['hihat, ride etc', ['normal-slidertick.wav', 'soft-slidertick.wav', 'drum-slidertick.ogg']],
	['kicks etc', ['normal-hitwhistle (kick).wav', 'soft-hitwhistle (kick).wav']],
	['oriental', ['normal-hitnormal (taiko drum).wav', 'soft-hitfinish (taiko).wav']],
	['special', ['spinnerbonus.wav', 'sectionfail.mp3', 'sectionpass.mp3']],
	['taiko', ['taiko-hitnormal.wav', 'taiko-hitclap.wav', 'taiko-hitfinish.wav']],
	['whistles', ['normal-hitwhistle.wav', 'soft-hitwhistle.wav']],
	['whistles/long', ['long normal-hitwhistle.wav', 'long soft-hitwhistle.ogg']],
	['wub', ['normal-hitnormal (wub).wav', 'soft-sliderslide (wub).wav']]
];

// 依文件扩展名给元数据：wav 无损全字段；ogg/mp3 位深为 null（有损）
function metaFor(ext: string, seed: number): Pick<FileRow, 'format' | 'durationS' | 'sampleRate' | 'bitDepth' | 'channels' | 'sizeBytes'> {
	const isLossy = ext !== 'wav';
	return {
		format: ext,
		durationS: 0.04 + (seed % 60) / 100, // 40ms ~ 100ms 量级的短音效
		sampleRate: [44100, 48000][seed % 2],
		bitDepth: isLossy ? null : [16, 24][seed % 2],
		channels: seed % 3 === 0 ? 1 : 2,
		sizeBytes: 3000 + seed * 977
	};
}

let seq = 0;
export const MOCK_FILES: FileRow[] = MOCK_ENTRIES.flatMap(([folder, names]) =>
	names.map((name) => {
		const ext = name.split('.').pop() ?? 'wav';
		seq += 1;
		return {
			id: `mock-${seq}`,
			name,
			folderPath: folder,
			...metaFor(ext, seq),
			peaks: fakePeaks(seq)
		};
	})
);

/** 由扁平文件列表聚合目录树（与服务端「DISTINCT folder_path 聚合」同一口径） */
export function buildTree(packageId: string, packageName: string, files: FileRow[]): TreeNode {
	const root: TreeNode = { name: packageName, key: `pkg:${packageId}`, isPackage: true, children: [] };
	const byPath = new Map<string, TreeNode>([['', root]]);

	// 先保证每个中间路径都有节点，再挂到父节点下
	const ensureFolder = (path: string): TreeNode => {
		const existing = byPath.get(path);
		if (existing) return existing;
		const slash = path.lastIndexOf('/');
		const parentPath = path.slice(0, slash);
		const node: TreeNode = {
			name: path.slice(slash + 1),
			key: `pkg:${packageId}/${path}`,
			isPackage: false,
			children: []
		};
		byPath.set(path, node);
		ensureFolder(parentPath).children.push(node);
		return node;
	};

	// 文件夹按名称排序，展示稳定
	for (const f of files) ensureFolder(f.folderPath);
	const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
		nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
		for (const n of nodes) sortNodes(n.children);
		return nodes;
	};
	sortNodes(root.children);
	return root;
}

export const MOCK_TREE: TreeNode = buildTree(PACKAGE_ID, PACKAGE_NAME, MOCK_FILES);

/** 取选中节点的文件列表：包根 = folderPath 为 ''，文件夹 = 精确匹配 */
export function filesOfNode(key: string): FileRow[] {
	if (!key.startsWith(`pkg:${PACKAGE_ID}`)) return [];
	const folder = key === `pkg:${PACKAGE_ID}` ? '' : key.slice(`pkg:${PACKAGE_ID}/`.length);
	return MOCK_FILES.filter((f) => f.folderPath === folder);
}
