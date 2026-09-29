// 中文文案字典：全部界面文案集中于此，键用点分命名空间；
// 新增语言时复制一份字典结构（如 en.ts）并在 ./index.ts 注册即可

const zh = {
	// 顶栏
	'app.title': 'hitsound 分享站',
	'app.tagline': 'osu! 铺面音效共享',
	'app.login': '登录',
	'app.upload': '上传',
	'app.github': '在 GitHub 上反馈问题',

	// 目录树面板
	'tree.title': '音效库',
	'tree.empty': '暂无内容',
	'tree.expand': '展开',
	'tree.collapse': '折叠',

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
	'action.rename': '重命名',
	'rename.failed': '改名失败，请重试（可能名称无效或网络问题）',

	// 整包下载（浏览器按当前内容实时打包）
	'download.packaging': '打包中 {n}/{total}…',
	'download.failedRetry': '下载失败，重试',
	'download.failedHint': '打包中断（网络错误等），点击重新打包',

	// 音效组装器（主页底部面板：拖文件表行到格子 → 按 <行>-<列><序号> 打包）
	'kit.title': '自定义音效组',
	'kit.hint': '从文件表拖拽音效到格子，同格可叠多个并各自加序号',
	'kit.count': '{count} 个音效',
	'kit.download': '打包下载',
	'kit.clear': '清空',
	'kit.suffix': '序号（可选）：填 2 → drum-hitnormal2.wav，留空 → drum-hitnormal.wav',
	'kit.remove': '移除',
	'kit.collapse': '收起',
	'kit.zipName': 'custom-hitsounds',
	'kit.dupName': '重名，解压时会互相覆盖，请调整序号',

	// 错误
	'error.load': '加载失败',

	// 登录/账户
	'auth.logout': '登出',
	'auth.myUploads': '我的上传',
	'auth.loginRequired': '请先登录',

	// 上传对话框
	'upload.title': '上传音效',
	'upload.pick': '选择 zip 或音频文件',
	'upload.hint': '支持 zip / rar 整包或单个 wav / ogg / mp3 文件，压缩包内非音频文件会被跳过（音频累计 ≤1GB）',
	'upload.groupName': '分组名称',
	'upload.start': '开始上传',
	'upload.mode.label': '上传方式',
	'upload.mode.new': '新建分组',
	'upload.mode.append': '附加到现有分组',
	'upload.appendTarget': '选择分组',
	'upload.appendCount': '{count} 个文件',
	'upload.appendHint': '文件将并入所选分组，整包下载自动包含其全部内容',
	'upload.parsing': '正在解析 {n}/{total} 个文件…',
	'upload.uploading': '正在上传 {n}/{total} 个文件…',
	'upload.finalizing': '正在核验入库…',
	'upload.done': '上传完成！',
	'upload.doneHint': '点击下方按钮刷新页面查看',
	'upload.viewNow': '立即查看',
	'upload.close': '关闭',
	'upload.retry': '重新选择',
	'upload.skipped': '跳过 {count} 个非音频文件',
	'upload.failed': '上传失败',
	'upload.log.title': '详细日志',
	'upload.log.copy': '复制日志',
	'upload.log.copied': '已复制',
	'upload.log.copyFailed': '复制失败',
	'upload.log.copyHint': '复制日志全文，可粘贴到 GitHub issue 反馈',

	// 上传错误码 → 中文
	'upload.err.bad_body': '请求数据无效',
	'upload.err.bad_name': '包名无效（1-100 字符）',
	'upload.err.bad_append_to': '附加目标无效',
	'upload.err.append_target_not_found': '目标分组不存在或无权附加',
	'upload.err.append_target_invalid': '目标分组当前不可附加，请稍后再试',
	'upload.err.appending_in_progress': '该分组有待完成的上传，请稍后再试',
	'upload.err.append_gone': '无法确认附加结果，请刷新页面查看；若未生效请重试',
	'upload.err.too_many_entries': '文件数超出限制（≤5000）',
	'upload.err.too_large': '音频总大小超出限制（≤1GB）',
	'upload.err.bad_path': '存在非法路径的文件',
	'upload.err.bad_ext': '不支持的文件格式（仅 zip / rar / wav / ogg / mp3）',
	'upload.err.unknown_format': '文件内容不是可识别的压缩包或与扩展名不符（7z 及其他格式请先转为 zip）',
	'upload.err.format_unsupported': '暂不支持该压缩格式（7z / 分卷 / zip64），请重新打包为 zip 或 rar',
	'upload.err.encrypted': '压缩包已加密，请上传未加密的压缩包',
	'upload.err.corrupt': '压缩包数据损坏或格式异常，无法解包，请重新压缩后再试',
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
	'upload.err.package_not_found': '分组不存在或无权访问',
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
