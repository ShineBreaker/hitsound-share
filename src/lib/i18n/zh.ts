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

	// 登录/账户
	'auth.logout': '登出',
	'auth.myUploads': '我的上传',
	'auth.loginRequired': '请先登录',

	// 上传对话框
	'upload.title': '上传音效包',
	'upload.pick': '选择 zip 压缩包',
	'upload.hint': '仅支持 zip（≤100MB），包内 wav / ogg / mp3 会被收录，其余文件跳过',
	'upload.parsing': '正在解析 {n}/{total} 个文件…',
	'upload.uploading': '正在上传 {n}/{total} 个文件…',
	'upload.uploadingZip': '正在上传压缩包…',
	'upload.finalizing': '正在核验入库…',
	'upload.done': '上传完成！',
	'upload.doneHint': '点击下方按钮刷新页面查看',
	'upload.viewNow': '立即查看',
	'upload.close': '关闭',
	'upload.retry': '重新选择',
	'upload.skipped': '跳过 {count} 个非音频文件',
	'upload.failed': '上传失败',

	// 上传错误码 → 中文
	'upload.err.bad_body': '请求数据无效',
	'upload.err.bad_name': '包名无效（1-100 字符）',
	'upload.err.bad_zip_size': '压缩包大小超出限制（≤100MB）',
	'upload.err.too_many_entries': '文件数超出限制（≤5000）',
	'upload.err.too_large': '音频总大小超出限制（≤1GB）',
	'upload.err.bad_path': '存在非法路径的文件',
	'upload.err.bad_ext': '存在不支持的文件格式',
	'upload.err.bad_hash': '文件校验信息无效',
	'upload.err.bad_size': '文件大小信息无效',
	'upload.err.bad_peaks': '波形数据无效',
	'upload.err.bad_entry': '文件条目无效',
	'upload.err.daily_limit': '每天最多上传 5 个包，请明天再试',
	'upload.err.storage_full': '站点存储已满，暂时无法接收新上传',
	'upload.err.not_logged_in': '请先登录',
	'upload.err.service_unavailable': '上传服务未配置，请联系管理员',
	'upload.err.manifest_failed': '提交清单失败，请重试',
	'upload.err.put_failed': '文件传输失败，请重试',
	'upload.err.blob_mismatch': '部分文件校验不一致，请重新上传',
	'upload.err.zip_missing': '压缩包未收到，请重试',
	'upload.err.zip_mismatch': '压缩包校验不一致，请重试',
	'upload.err.zip_too_large': '压缩包实际大小超出限制（≤100MB）',
	'upload.err.network': '网络错误，请重试',

	// 我的上传
	'my.title': '我的上传',
	'my.empty': '还没有上传过音效包',
	'my.fileCount': '{count} 个文件',
	'my.status.visible': '已发布',
	'my.status.pending': '处理中',
	'my.delete': '删除',
	'my.confirmDelete': '确定删除「{name}」？该操作不可恢复。',
	'my.deleteFailed': '删除失败，请重试',
	'my.deleted': '已删除',

	// 元数据展示
	'meta.unknown': '—',
	'meta.channels.mono': '单声道',
	'meta.channels.stereo': '立体声',
	'meta.channels.n': '{count} 声道'
} as const;

export default zh;
export type Dict = typeof zh;
