// 领域类型：字段与 schema.sql 的表结构对应（展示口径）

/** 文件表一行（files 表的展示字段；peaks 按需加载） */
export interface FileRow {
	id: string; // files.id（uuid）
	name: string; // 文件名（不含路径，可能含 # 空格 & 逗号，渲染靠 Svelte 默认转义）
	folderPath: string; // 包内相对文件夹路径（'' = 包根）
	format: string; // wav / ogg / mp3
	durationS: number | null;
	sampleRate: number | null;
	bitDepth: number | null; // 有损格式为 null
	channels: number | null;
	sizeBytes: number;
	ownerOsuId: number | null; // 上传者（文件级所有权）；null = 系统导入（仅管理员可动）
	ownerName: string | null; // 上传者用户名（users.username，展示用；系统导入为 null）
	peaks: number[] | null; // 波形峰值数组（0-1），未加载为 null
}

/** 目录树节点：顶层 = 各包，包内 = 文件夹层级（由 folder_path 聚合） */
export interface TreeNode {
	name: string; // 显示名（包名或文件夹名）
	key: string; // 选中键：包 'pkg:<id>'，文件夹 'pkg:<id>/<folderPath>'
	isPackage: boolean;
	children: TreeNode[];
	ownerOsuId: number | null; // 所属包上传者（各节点冗余携带，改名按钮显示用）
	ownerName: string | null; // 所属包上传者用户名（包节点展示用，各节点冗余携带）
}

/** 整包下载清单（/api/package/<id>/zip）：当前 files 全列 + 去重 hash 的拉取 URL */
export interface ZipManifest {
	name: string;
	files: Array<{ path: string; hash: string; ext: string; size: number }>;
	urls: Record<string, string>;
}
