<script lang="ts">
	// 上传对话框：选 zip 整包或单个音频文件 → fflate 解析 → 每文件 sha256 + 元数据
	// （wav 手解 RIFF 头，decodeAudioData 得时长/声道/波形；解码失败的文件元数据置 null 仍可上传）
	// → POST /api/upload（manifest）→ 浏览器直传缺失 blob 与 original.zip（预签名 PUT）
	// → POST /api/upload/done（服务端核验）→ 完成刷新。
	// 单音频文件先确认分组名（默认上传者用户名），再现场打成单条目 zip（STORE）走同一链路
	import { unzip, zipSync } from 'fflate';
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

	function safeUrl(url: string): string {
		try {
			const u = new URL(url, location.href);
			return u.origin + u.pathname;
		} catch {
			return url;
		}
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

	/** wav 手解 RIFF 头：fmt 块的声道/采样率/位深 + byteRate（算时长） */
	function parseWavHeader(d: Uint8Array): {
		channels: number;
		sampleRate: number;
		bitDepth: number;
		byteRate: number;
	} | null {
		if (d.length < 12) return null;
		const tag = (o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
		if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
		const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
		let off = 12;
		while (off + 8 <= d.length) {
			const id = tag(off);
			const size = dv.getUint32(off + 4, true);
			if (id === 'fmt ' && off + 24 <= d.length) {
				return {
					channels: dv.getUint16(off + 10, true),
					sampleRate: dv.getUint32(off + 12, true),
					bitDepth: dv.getUint16(off + 22, true),
					byteRate: dv.getUint32(off + 16, true)
				};
			}
			off += 8 + size + (size % 2); // chunk 按 2 字节对齐
		}
		return null;
	}

	async function sha256Hex(d: Uint8Array): Promise<string> {
		// slice 复制防 ArrayBuffer 被 detach（digest 不 detach，防御性）
		const h = await crypto.subtle.digest('SHA-256', d.slice().buffer as ArrayBuffer);
		return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
	}

	/** decodeAudioData：时长/采样率/声道 + 200 桶峰值波形；解码失败返回 null */
	async function decodeMeta(
		data: Uint8Array
	): Promise<{ durationS: number; sampleRate: number; channels: number; peaks: number[] } | null> {
		try {
			// 借 OfflineAudioContext 的解码器（无需用户手势）；decodeAudioData 会接管 buffer，传副本
			const ctx = new OfflineAudioContext(1, 1, 44100);
			const buf = await ctx.decodeAudioData(data.slice().buffer as ArrayBuffer);
			const ch = buf.getChannelData(0);
			const n = 200;
			const peaks: number[] = [];
			const step = Math.max(1, Math.floor(ch.length / n));
			for (let i = 0; i < n; i++) {
				let m = 0;
				const s = i * step;
				for (let j = 0; j < step && s + j < ch.length; j++) {
					const v = Math.abs(ch[s + j]);
					if (v > m) m = v;
				}
				peaks.push(Math.round(Math.min(1, m) * 1000) / 1000);
			}
			return {
				durationS: Math.round(buf.duration * 1000) / 1000,
				sampleRate: buf.sampleRate,
				channels: buf.numberOfChannels,
				peaks
			};
		} catch {
			return null;
		}
	}

	interface Entry {
		path: string;
		hash: string;
		size: number;
		ext: string;
		durationS: number | null;
		sampleRate: number | null;
		bitDepth: number | null;
		channels: number | null;
		peaks: number[] | null;
	}

	/** 构造单文件条目：解码元数据优先；wav 且解码失败时回退 RIFF 手解（时长 = 大小/字节率） */
	async function buildEntry(path: string, d: Uint8Array, ext: string, hash: string): Promise<Entry> {
		const wav = ext === 'wav' ? parseWavHeader(d) : null;
		const dec = await decodeMeta(d);
		return {
			path,
			hash,
			size: d.length,
			ext,
			durationS: dec?.durationS ?? (wav && wav.byteRate > 0 ? d.length / wav.byteRate : null),
			sampleRate: dec?.sampleRate ?? wav?.sampleRate ?? null,
			bitDepth: dec ? (ext === 'wav' ? (wav?.bitDepth ?? null) : null) : (wav?.bitDepth ?? null),
			channels: dec?.channels ?? wav?.channels ?? null,
			peaks: dec?.peaks ?? null
		};
	}

	function fail(key: string): void {
		phase = 'error';
		errorKey = key;
	}

	/** 取小写扩展名；无扩展名返回空串 */
	function fileExt(name: string): string {
		const i = name.lastIndexOf('.');
		return i === -1 ? '' : name.slice(i + 1).toLowerCase();
	}

	async function onFileChosen(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const ext = fileExt(file.name);
		addLog('info', `选择文件 ${file.name}（${fmtBytes(file.size)}）`);
		if (ext !== 'zip' && !['wav', 'ogg', 'mp3'].includes(ext)) {
			addLog('error', `不支持的扩展名：${ext || '（无）'}`);
			fail('bad_ext');
			return;
		}
		// 分组名预填：zip 用文件名，单文件默认上传者用户名
		pendingFile = file;
		groupName = ext === 'zip' ? file.name.replace(/\.zip$/i, '') : username;
		phase = 'confirm';
	}

	function confirmUpload(): void {
		const file = pendingFile;
		const name = groupName.trim();
		if (!file || !name) return;
		const single = fileExt(file.name) !== 'zip';
		pendingFile = null;
		addLog('info', `分组名：${name}`);
		void startUpload(file, name, single);
	}

	async function startUpload(file: File, name: string, single: boolean): Promise<void> {
		phase = 'parsing';
		skippedCount = 0;
		try {
			const entries: Entry[] = [];
			const blobData = new Map<string, Uint8Array>(); // hash → 原始字节（直传用，天然去重）
			// original.zip 载荷与大小：zip 整包回放原文件；单文件为现场打包产物
			let zipBody: File | Uint8Array = file;
			let zipSize = file.size;

			if (single) {
				const d = new Uint8Array(await file.arrayBuffer());
				const ext = fileExt(file.name);
				progressTotal = 1;
				progressN = 0;
				const hash = await sha256Hex(d);
				blobData.set(hash, d);
				entries.push(await buildEntry(file.name, d, ext, hash));
				progressN = 1;
				addLog('info', `解析完成：1 个文件（${ext}，sha256 ${hash.slice(0, 12)}…）`);
				// STORE 不压缩：开销只有 zip 头部，解包得到原字节
				zipBody = zipSync({ [file.name]: d }, { level: 0 });
				zipSize = zipBody.length;
				addLog('info', `打包 original.zip：${fmtBytes(zipSize)}`);
			} else {
				const buf = new Uint8Array(await file.arrayBuffer());
				const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
					unzip(buf, (err, unzipped) => (err ? reject(err) : resolve(unzipped)))
				);

				// 目录条目（以 / 结尾）跳过；非音频扩展名跳过
				const paths = Object.keys(files).filter((p) => !p.endsWith('/'));
				const audioPaths = paths.filter((p) => {
					const ext = p.split('.').pop()?.toLowerCase() ?? '';
					return ['wav', 'ogg', 'mp3'].includes(ext);
				});
				skippedCount = paths.length - audioPaths.length;
				addLog('info', `解包完成：${audioPaths.length} 个音频 / 跳过 ${skippedCount} 个`);
				if (audioPaths.length === 0) {
					addLog('error', 'zip 内没有可收录的音频文件（wav / ogg / mp3）');
					fail('bad_ext');
					return;
				}

				progressTotal = audioPaths.length;
				progressN = 0;
				for (const path of audioPaths) {
					const d = files[path];
					const ext = path.split('.').pop()?.toLowerCase() ?? 'wav';
					const hash = await sha256Hex(d);
					if (!blobData.has(hash)) blobData.set(hash, d);
					entries.push(await buildEntry(path, d, ext, hash));
					progressN += 1;
					// 每个文件让出一帧，长列表解析期间界面不冻结
					await new Promise((r) => setTimeout(r, 0));
				}
			}

			// 1. manifest（服务端强校验 + 秒传判定，返回缺失清单与预签名 URL）
			phase = 'uploading';
			const mres = await fetch('/api/upload', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, zipSize, entries })
			});
			const mdata = (await mres.json().catch(() => ({}))) as {
				packageId?: string;
				missing?: Array<{ hash: string; url: string }>;
				zipUrl?: string;
				existingCount?: number;
				error?: string;
			};
			if (!mres.ok || !mdata.packageId || !mdata.zipUrl) {
				addLog('error', `POST /api/upload → ${mres.status}${mdata.error ? ` ${mdata.error}` : ''}`);
				fail(mdata.error ?? 'manifest_failed');
				return;
			}
			addLog(
				'info',
				`POST /api/upload → ${mres.status}（待直传 ${mdata.missing?.length ?? 0}，秒传 ${mdata.existingCount ?? 0}）`
			);

			// 2. 直传缺失 blob（同 hash 已有即秒传跳过）
			progressTotal = mdata.missing?.length ?? 0;
			progressN = 0;
			for (const m of mdata.missing ?? []) {
				const body = blobData.get(m.hash);
				if (!body) {
					addLog('error', `本地缺少 blob 数据：${m.hash.slice(0, 12)}…`);
					fail('bad_hash');
					return;
				}
				const pres = await fetch(m.url, { method: 'PUT', body });
				if (!pres.ok) {
					const detail = (await pres.text().catch(() => '')).slice(0, 200);
					addLog('error', `PUT ${safeUrl(m.url)} → ${pres.status}${detail ? ` ${detail}` : ''}`);
					fail('put_failed');
					return;
				}
				progressN += 1;
			}
			if (progressTotal > 0) addLog('info', `音频直传完成：${progressTotal} 个`);

			// 3. original.zip（单文件为现场打包产物）
			const zres = await fetch(mdata.zipUrl, { method: 'PUT', body: zipBody });
			if (!zres.ok) {
				const detail = (await zres.text().catch(() => '')).slice(0, 200);
				addLog('error', `PUT ${safeUrl(mdata.zipUrl)} → ${zres.status}${detail ? ` ${detail}` : ''}`);
				fail('put_failed');
				return;
			}
			addLog('info', `PUT original.zip → ${zres.status}`);

			// 4. done 闭环核验
			phase = 'finalizing';
			const dres = await fetch('/api/upload/done', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ packageId: mdata.packageId, zipSize })
			});
			if (!dres.ok) {
				const derr = ((await dres.json().catch(() => ({}))) as { error?: string; bad?: string[] }).error;
				addLog('error', `POST /api/upload/done → ${dres.status}${derr ? ` ${derr}` : ''}`);
				fail(derr ?? 'blob_mismatch');
				return;
			}
			addLog('info', `POST /api/upload/done → ${dres.status}`);
			phase = 'done';
		} catch (err) {
			addLog('error', `异常中断：${err instanceof Error ? err.message : String(err)}`);
			fail('network');
		}
	}

	function reset(): void {
		phase = 'idle';
		pendingFile = null;
		logs = [];
		copyState = 'idle';
		if (fileInput) fileInput.value = '';
	}

	// 错误码 → 中文（未知码回退网络错误文案；t 对缺失键返回键名本身）
	const errText = $derived.by(() => {
		const key = `upload.err.${errorKey}` as Parameters<typeof t>[0];
		const text = t(key);
		return text === key ? t('upload.err.network') : text;
	});
</script>

<div class="mask" role="dialog" aria-modal="true" aria-label={t('upload.title')}>
	<div class="card">
		<h2>{t('upload.title')}</h2>

		{#if phase === 'idle'}
			<p class="hint">{t('upload.hint')}</p>
			<input
				bind:this={fileInput}
				type="file"
				accept=".zip,.wav,.ogg,.mp3"
				onchange={(e) => void onFileChosen(e)}
			/>
		{:else if phase === 'confirm'}
			<p class="file-line" title={pendingFile?.name}>{pendingFile?.name}</p>
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
		{:else if busy}
			<div class="phase-text">
				{#if phase === 'parsing'}
					{t('upload.parsing', { n: progressN, total: progressTotal })}
				{:else if phase === 'uploading'}
					{#if progressN < progressTotal || progressTotal === 0}
						{t('upload.uploading', { n: progressN, total: progressTotal })}
					{:else}
						{t('upload.uploadingZip')}
					{/if}
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
				<button class="btn primary" onclick={() => location.reload()}>{t('upload.viewNow')}</button>
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
			<button class="close" aria-label={t('upload.close')} onclick={onclose}>×</button>
		{/if}
	</div>
</div>

<style>
	.mask {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--bg-l1) 70%, transparent);
	}

	.card {
		position: relative;
		width: min(480px, calc(100vw - 40px));
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		padding: 22px 24px;
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
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

	.phase-text {
		color: var(--text);
		font-size: 14px;
		margin: 6px 0 12px;
	}

	.ok {
		color: var(--accent-bright);
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
		border-radius: var(--radius);
		background: var(--bg-l3);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: linear-gradient(90deg, var(--accent), var(--accent-pink));
		transition: width 0.2s ease;
	}

	.row {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}

	.btn {
		padding: 6px 16px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
	}
	.btn:hover {
		background: var(--bg-l3);
		color: var(--text);
	}
	.btn.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--text);
		font-weight: 600;
	}
	.btn.primary:hover {
		background: var(--accent-deep);
		border-color: var(--accent-deep);
	}

	input[type='file'] {
		width: 100%;
		color: var(--text-dim);
		font-family: inherit;
	}

	/* confirm 阶段：待上传文件名 + 分组名输入 */
	.file-line {
		color: var(--text-dim);
		font-size: 13px;
		margin: 4px 0 12px;
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
		background: var(--bg-l1);
		color: var(--text);
		font-family: inherit;
		font-size: 13px;
	}
	.text:focus {
		outline: none;
		border-color: var(--accent);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn:disabled:hover {
		background: transparent;
		color: var(--text-dim);
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
		background: var(--bg-l1);
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

	.close {
		position: absolute;
		top: 10px;
		right: 12px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 20px;
		cursor: pointer;
	}
	.close:hover {
		color: var(--text);
	}
</style>
