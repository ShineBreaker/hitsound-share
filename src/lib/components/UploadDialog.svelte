<script lang="ts">
	// 上传对话框（纯 UI 壳）：文件选择/拖放 → confirm（新建 / 附加到现有分组）→
	// runUpload（$lib/upload-pipeline：解包 → sha256+元数据 → manifest → 直传 → done，
	// 进度与日志经 onEvent 上报）→ 完成刷新。v4 起不再上传 original.zip。
	// 忙碌中 Esc 不关对话框（防误触中断进行中上传）
	import { onMount } from 'svelte';
	import { loadUnrarWasm } from '$lib/unrar-wasm';
	import { decodeMeta } from '$lib/audio-meta';
	import {
		runUpload,
		UploadError,
		ARCHIVE_EXTS,
		fileExt,
		type UploadTarget
	} from '$lib/upload-pipeline';
	import { t } from '$lib/i18n';

	interface Props {
		onclose: () => void;
		username: string; // 单文件上传的默认分组名
	}
	let { onclose, username }: Props = $props();

	type Phase = 'idle' | 'confirm' | 'parsing' | 'uploading' | 'finalizing' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let errorKey = $state('network');
	let progressN = $state(0);
	let progressTotal = $state(0);
	let skippedCount = $state(0);
	let pendingFile = $state<File | null>(null); // confirm 阶段持有的单音频文件
	let groupName = $state('');
	let fileInput = $state<HTMLInputElement | undefined>();
	let dropOver = $state(false); // 拖放区悬停高亮

	// confirm 阶段的目标模式：新建分组 / 附加到现有分组（有自己的 visible 包才有附加选项）
	type Mode = 'new' | 'append';
	let mode = $state<Mode>('new');
	let appendTarget = $state(''); // 附加目标包 id
	interface MyPkg {
		id: string;
		name: string;
		status: string;
		file_count: number;
	}
	let myPkgs = $state<MyPkg[]>([]);
	let myPkgsLoaded = $state(false);
	const visiblePkgs = $derived(myPkgs.filter((p) => p.status === 'visible'));

	/** 进入 confirm 时拉一次我的包列表（附加下拉数据源；失败则不显示附加选项） */
	async function loadMyPackages(): Promise<void> {
		if (myPkgsLoaded) return;
		try {
			const res = await fetch('/api/my/packages');
			if (!res.ok) throw new Error();
			myPkgs = ((await res.json()) as { packages: MyPkg[] }).packages;
			myPkgsLoaded = true;
		} catch {
			/* 未登录/网络失败：保持仅新建模式 */
		}
	}

	// 过程日志：失败时展开供用户复制反馈（预签名 URL 只记 host+path，签名参数不落日志）
	interface LogLine {
		time: string;
		level: 'info' | 'error';
		msg: string;
	}
	let logs = $state<LogLine[]>([]);
	let copyState = $state<'idle' | 'ok' | 'fail'>('idle');

	function addLog(level: LogLine['level'], msg: string): void {
		const now = new Date();
		const p = (n: number, w: number) => String(n).padStart(w, '0');
		const time = `${p(now.getHours(), 2)}:${p(now.getMinutes(), 2)}:${p(now.getSeconds(), 2)}.${p(now.getMilliseconds(), 3)}`;
		logs.push({ time, level, msg: msg.length > 500 ? `${msg.slice(0, 500)}…` : msg });
	}

	function fmtBytes(n: number): string {
		if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
		return `${n} B`;
	}

	async function copyLogs(): Promise<void> {
		const text = logs.map((l) => `[${l.time}] ${l.level === 'error' ? '✗' : '·'} ${l.msg}`).join('\n');
		try {
			await navigator.clipboard.writeText(text);
			copyState = 'ok';
		} catch {
			copyState = 'fail';
		}
		setTimeout(() => (copyState = 'idle'), 1500);
	}

	const busy = $derived(phase === 'parsing' || phase === 'uploading' || phase === 'finalizing');
	const pct = $derived(
		progressTotal > 0 ? Math.round((progressN / progressTotal) * 100) : 0
	);

	function fail(key: string): void {
		phase = 'error';
		errorKey = key;
	}

	/** 选定文件（文件选择器 / 拖放区共用入口） */
	function chooseFile(file: File): void {
		const ext = fileExt(file.name);
		addLog('info', `选择文件 ${file.name}（${fmtBytes(file.size)}）`);
		if (!ARCHIVE_EXTS.includes(ext) && !['wav', 'ogg', 'mp3'].includes(ext)) {
			addLog('error', `不支持的扩展名：${ext || '（无）'}`);
			fail('bad_ext');
			return;
		}
		// 分组名预填：压缩包用文件名，单文件默认上传者用户名
		pendingFile = file;
		groupName = ARCHIVE_EXTS.includes(ext)
			? file.name.replace(/\.(zip|rar)$/i, '')
			: username;
		mode = 'new';
		appendTarget = '';
		phase = 'confirm';
		void loadMyPackages();
	}

	function onFileChosen(e: Event): void {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) chooseFile(file);
	}

	function confirmUpload(): void {
		const file = pendingFile;
		const name = groupName.trim();
		if (!file) return;
		if (mode === 'append') {
			if (!appendTarget) return;
			pendingFile = null;
			addLog('info', `附加到现有分组：${appendTarget}`);
			void startUpload(file, { kind: 'append', packageId: appendTarget });
			return;
		}
		if (!name) return;
		pendingFile = null;
		addLog('info', `分组名：${name}`);
		void startUpload(file, { kind: 'new', name });
	}

	async function startUpload(file: File, target: UploadTarget): Promise<void> {
		phase = 'parsing';
		skippedCount = 0;
		try {
			await runUpload({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, target, {
				fetch: fetch.bind(window),
				loadWasm: loadUnrarWasm,
				decodeMeta
			}, (e) => {
				if (e.type === 'phase') phase = e.phase;
				else if (e.type === 'progress') {
					progressN = e.n;
					progressTotal = e.total;
				} else if (e.type === 'skipped') skippedCount = e.count;
				else addLog(e.level, e.msg);
			});
			phase = 'done';
		} catch (err) {
			fail(err instanceof UploadError ? err.code : 'network');
		}
	}

	function reset(): void {
		phase = 'idle';
		pendingFile = null;
		logs = [];
		copyState = 'idle';
		if (fileInput) fileInput.value = '';
	}

	/** 完成后「立即查看」：先强制预热树缓存（绕 60s max-age），再刷新页面立即可见 */
	function viewNow(): void {
		void fetch('/api/tree', { cache: 'reload' })
			.catch(() => 0)
			.then(() => location.reload());
	}

	// 错误码 → 中文（未知码回退网络错误文案；t 对缺失键返回键名本身）
	const errText = $derived.by(() => {
		const key = `upload.err.${errorKey}` as Parameters<typeof t>[0];
		const text = t(key);
		return text === key ? t('upload.err.network') : text;
	});

	let cardEl = $state<HTMLElement | undefined>();
	onMount(() => {
		// 打开即聚焦首个控件（idle 阶段的拖放区 label）
		cardEl?.querySelector<HTMLElement>('input, select, button, [tabindex]')?.focus();
		// Esc 关闭；忙碌中不响应（防误触中断进行中上传）
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !busy) onclose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	// 进入 confirm 阶段时聚焦名称输入 / 附加下拉
	$effect(() => {
		if (phase === 'confirm') {
			const el =
				cardEl?.querySelector<HTMLElement>('#group-name') ??
				cardEl?.querySelector<HTMLElement>('#append-target');
			el?.focus();
		}
	});
</script>

<div class="dialog-mask" role="dialog" aria-modal="true" aria-label={t('upload.title')}>
	<div class="dialog-card card" bind:this={cardEl}>
		<h2>{t('upload.title')}</h2>

		{#if phase === 'idle'}
			<!-- 拖放区（编辑器「把视频文件拖至此处」同款）：label 触发隐藏 input，dragover 高亮 -->
			<label
				class="drop"
				class:over={dropOver}
				tabindex="0"
				ondragover={(e) => {
					if (!e.dataTransfer?.types.includes('Files')) return;
					e.preventDefault();
					e.dataTransfer.dropEffect = 'copy';
					dropOver = true;
				}}
				ondragleave={(e) => {
					if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
						dropOver = false;
				}}
				ondrop={(e) => {
					e.preventDefault();
					dropOver = false;
					const f = e.dataTransfer?.files?.[0];
					if (f) chooseFile(f);
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						fileInput?.click();
					}
				}}
			>
				<svg class="drop-icon" viewBox="0 0 24 24" aria-hidden="true">
					<path
						d="M12 4v10m0-10-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="drop-text">{t('upload.drop')}</span>
				<span class="drop-hint">{t('upload.hint')}</span>
				<input
					bind:this={fileInput}
					type="file"
					accept=".zip,.rar,.wav,.ogg,.mp3"
					class="vh"
					onchange={onFileChosen}
				/>
			</label>
		{:else if phase === 'confirm'}
			<p class="file-line" title={pendingFile?.name}>{pendingFile?.name}</p>
			{#if visiblePkgs.length > 0}
				<div class="seg" role="radiogroup" aria-label={t('upload.mode.label')}>
					<label class="seg-item">
						<input type="radio" bind:group={mode} value="new" />
						{t('upload.mode.new')}
					</label>
					<label class="seg-item">
						<input type="radio" bind:group={mode} value="append" />
						{t('upload.mode.append')}
					</label>
				</div>
			{/if}
			{#if mode === 'append'}
				<label class="lbl" for="append-target">{t('upload.appendTarget')}</label>
				<select id="append-target" class="text" bind:value={appendTarget}>
					{#each visiblePkgs as p (p.id)}
						<option value={p.id}>{p.name}（{t('upload.appendCount', { count: p.file_count })}）</option>
					{/each}
				</select>
				<p class="hint">{t('upload.appendHint')}</p>
				<div class="row">
					<button class="btn primary" disabled={!appendTarget} onclick={confirmUpload}>
						{t('upload.start')}
					</button>
					<button class="btn" onclick={reset}>{t('upload.retry')}</button>
				</div>
			{:else}
				<label class="lbl" for="group-name">{t('upload.groupName')}</label>
				<input
					id="group-name"
					class="text"
					bind:value={groupName}
					maxlength="100"
					placeholder={username}
				/>
				<div class="row">
					<button class="btn primary" disabled={!groupName.trim()} onclick={confirmUpload}>
						{t('upload.start')}
					</button>
					<button class="btn" onclick={reset}>{t('upload.retry')}</button>
				</div>
			{/if}
		{:else if busy}
			<div class="phase-text">
				{#if phase === 'parsing'}
					{t('upload.parsing', { n: progressN, total: progressTotal })}
				{:else if phase === 'uploading'}
					{t('upload.uploading', { n: progressN, total: progressTotal })}
				{:else}
					{t('upload.finalizing')}
				{/if}
			</div>
			<div class="bar"><div class="fill" style:width={`${pct}%`}></div></div>
			{#if phase === 'parsing' && skippedCount > 0}
				<p class="hint">{t('upload.skipped', { count: skippedCount })}</p>
			{/if}
		{:else if phase === 'done'}
			<p class="ok">{t('upload.done')}</p>
			<p class="hint">{t('upload.doneHint')}</p>
			<div class="row">
				<button class="btn primary" onclick={viewNow}>{t('upload.viewNow')}</button>
				<button class="btn" onclick={reset}>{t('upload.close')}</button>
			</div>
		{:else if phase === 'error'}
			<p class="err">{t('upload.failed')}</p>
			<p class="hint">{errText}</p>
			<div class="logwrap">
				<details class="logbox">
					<summary>{t('upload.log.title')}（{logs.length}）</summary>
					<div class="logbody">
						{#each logs as l}
							<div class="logline {l.level}"><span class="lt">[{l.time}]</span> {l.msg}</div>
						{/each}
					</div>
				</details>
				<button
					class="btn"
					title={t('upload.log.copyHint')}
					onclick={() => void copyLogs()}
				>
					{copyState === 'ok'
						? t('upload.log.copied')
						: copyState === 'fail'
							? t('upload.log.copyFailed')
							: t('upload.log.copy')}
				</button>
			</div>
			<div class="row">
				<button class="btn primary" onclick={reset}>{t('upload.retry')}</button>
			</div>
		{/if}

		{#if !busy}
			<button class="dialog-close" aria-label={t('upload.close')} onclick={onclose}>×</button>
		{/if}
	</div>
</div>

<style>
	/* 对话框骨架与按钮基元在 app.css（.dialog-* / .btn）；只留本组件差异化样式 */
	.card {
		width: min(480px, calc(100vw - 40px));
	}

	h2 {
		margin: 0 0 14px;
		font-size: 17px;
	}

	.hint {
		color: var(--text-faint);
		font-size: 13px;
		margin: 10px 0;
	}

	/* 拖放区：凹陷虚线框，悬停/拖入薄荷描边 */
	.drop {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 30px 20px;
		border: 1px dashed color-mix(in srgb, var(--text-faint) 55%, transparent);
		border-radius: 10px;
		background: var(--bg-inset);
		cursor: pointer;
		text-align: center;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}
	.drop:hover {
		border-color: var(--accent);
	}
	.drop.over {
		border-style: solid;
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-inset));
	}

	.drop-icon {
		width: 26px;
		height: 26px;
		color: var(--accent-bright);
	}

	.drop-text {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.drop-hint {
		font-size: 12px;
		color: var(--text-faint);
	}

	/* 隐藏但可激活的文件输入（label 点击触发） */
	.vh {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.phase-text {
		color: var(--text);
		font-size: 14px;
		margin: 6px 0 12px;
	}

	.ok {
		color: var(--accent);
		font-weight: 600;
		margin: 6px 0;
	}

	.err {
		color: var(--accent-pink);
		font-weight: 600;
		margin: 6px 0;
	}

	.bar {
		height: 8px;
		border-radius: 999px;
		background: var(--bg-inset);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent-deep), var(--accent));
		transition: width 0.2s ease;
	}

	.row {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}

	/* 对话框内按钮统一大号尺寸 */
	.row .btn {
		padding: 6px 16px;
	}

	/* confirm 阶段：待上传文件名（凹陷行）+ 分组名输入 */
	.file-line {
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

	/* confirm 阶段：新建 / 附加 分段选择器（编辑器 chip 组同款） */
	.seg {
		display: flex;
		gap: 4px;
		padding: 3px;
		margin: 4px 0 12px;
		background: var(--bg-inset);
		border: 1px solid var(--bg-l3);
		border-radius: 8px;
	}

	.seg-item {
		flex: 1;
		position: relative;
		text-align: center;
		padding: 5px 10px;
		border-radius: var(--radius);
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
		transition:
			background 0.15s ease,
			color 0.15s ease;
	}
	.seg-item:hover {
		color: var(--text);
	}
	.seg-item input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.seg-item:has(input:checked) {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.seg-item:has(input:focus-visible) {
		outline: 2px solid var(--accent);
	}

	/* 失败详情日志：默认收缩（details），旁边复制按钮一键带走全文 */
	.logwrap {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin-top: 12px;
	}

	.logbox {
		flex: 1;
		min-width: 0;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: var(--bg-inset);
	}

	.logbox summary {
		padding: 6px 10px;
		color: var(--text-faint);
		font-size: 12px;
		cursor: pointer;
		user-select: none;
	}
	.logbox summary:hover {
		color: var(--text);
	}

	.logbody {
		max-height: 180px;
		overflow: auto;
		padding: 6px 10px 8px;
		border-top: 1px solid var(--bg-l3);
		font-family: ui-monospace, 'Cascadia Mono', 'Source Code Pro', Menlo, Consolas, monospace;
		font-size: 12px;
		line-height: 1.55;
		color: var(--text-dim);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.logline.error {
		color: var(--accent-pink);
	}

	.lt {
		color: var(--text-faint);
	}

	.logwrap .btn {
		flex: none;
		white-space: nowrap;
	}
</style>
