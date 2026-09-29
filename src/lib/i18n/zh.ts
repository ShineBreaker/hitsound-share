// 中文文案字典：全部界面文案集中于此，键用点分命名空间；
// 新增语言时复制一份字典结构（如 en.ts）并在 ./index.ts 注册即可

const zh = {
	// 顶栏
	'app.title': 'hitsound 分享站',
	'app.tagline': 'osu! 铺面音效共享',
	'app.login': '登录',
	'app.upload': '上传',

	// 目录树面板
	'tree.title': '音效库',
	'tree.empty': '暂无内容',

	// 文件表列头
	'file.name': '文件名',
	'file.format': '格式',
	'file.duration': '时长',
	'file.sampleRate': '采样率',
	'file.bitDepth': '采样深度',
	'file.channels': '声道',
	'file.waveform': '波形',

	// 文件表状态
	'table.empty': '该文件夹没有文件',
	'table.loading': '加载中…',
	'table.loadMore': '加载更多',
	'table.fileCount': '{count} 个文件',

	// 操作
	'action.play': '播放',
	'action.pause': '暂停',
	'action.download': '下载',
	'action.downloadPackage': '下载整包',
	'action.retry': '重试',

	// 错误
	'error.load': '加载失败',

	// 元数据展示
	'meta.unknown': '—',
	'meta.channels.mono': '单声道',
	'meta.channels.stereo': '立体声',
	'meta.channels.n': '{count} 声道'
} as const;

export default zh;
export type Dict = typeof zh;
