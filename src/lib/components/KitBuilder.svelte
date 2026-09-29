<script lang="ts">
	// 自定义音效组悬浮面板（命名 <行>-<列><序号>.<格式>，如 drum-hitnormal2.wav）：
	// 收起态 = 右下角悬浮钮（GitHub 反馈钮旁），展开态 = 右下角浮层面板；
	// 文件表行可拖入格子（DND_FILE_MIME 自定义类型，拖起时面板自动展开）；
	// 每格可叠多个文件、各自可选数字序号（'' = 无后缀）；「打包下载」按当前格子内容
	// 实时拉 /f/<id> 全量（同 id 去重）→ fflate 流式 STORE 拼 zip → 保存（同整包下载策略）
	import { onMount } from 'svelte';
	import { Zip, ZipDeflate } from 'fflate';
	import { t } from '$lib/i18n';
	import { DND_FILE_MIME, type KitDragData } from '$lib/api';

	const ROWS = ['normal', 'soft', 'drum'] as const;
	const COLS = ['hitnormal', 'hitwhistle', 'hitfinish', 'hitclap'] as const;

	interface KitItem {
		uid: number; // 同一文件可重复入格，each 键必须全局唯一
		id: string; // files.id → /f/<id> 取数据
		name: string; // 源文件名（格子内显示）
		format: string; // 目标扩展名沿用源格式
		suffix: string; // 可选数字序号（'' = 无后缀）
	}

	let open = $state(false);
	let uidSeq = 0;
	let cells = $state<Record<string, KitItem[]>>({});
	let overKey = $state(''); // 拖拽悬停中的格子 key（高亮）

	// 打包状态机：idle / packing（x/y）/ error（按钮变红，点击重试）
	let dlState = $state<'idle' | 'packing' | 'error'>('idle');
	let dlDone = $state(0);
	let dlTotal = $state(0);

	// 预览播放：面板独立 Audio（与主播放器互不干扰）
	let audio: HTMLAudioElement | null = null;
	let playingUid = $state(-1);
	let playingPaused = $state(false);

	// 展平为打包清单：target = <行>-<列><序号>.<格式>
	const entries = $derived.by(() => {
		const out: Array<{ uid: number; id: string; target: string }> = [];
		for (const row of ROWS) {
			for (const col of COLS) {
				for (const it of cells[`${row}/${col}`] ?? []) {
					out.push({ uid: it.uid, id: it.id, target: `${row}-${col}${it.suffix}.${it.format}` });
				}
			}
		}
		return out;
	});
	const itemCount = $derived(entries.length);

	// 重名检测：zip 内同名条目解压时互相覆盖，标红提醒用户调序号
	const dupTargets = $derived.by(() => {
		const seen = new Map<string, number>();
		for (const e of entries) seen.set(e.target, (seen.get(e.target) ?? 0) + 1);
		return new Set([...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n));
	});

	function allowDrop(e: DragEvent, key: string): void {
		if (!e.dataTransfer?.types.includes(DND_FILE_MIME)) return;
		e.preventDefault(); // 必须 preventDefault 才触发 drop
		e.dataTransfer.dropEffect = 'copy';
		overKey = key;
	}

	function leaveCell(e: DragEvent, key: string): void {
		// 移入格子内子元素也触发 dragleave：只在真正离开格子时清高亮
		if (
			overKey === key &&
			!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)
		) {
			overKey = '';
		}
	}

	function drop(e: DragEvent, key: string): void {
		if (!e.dataTransfer?.types.includes(DND_FILE_MIME)) return;
		e.preventDefault();
		overKey = '';
		try {
			const f = JSON.parse(e.dataTransfer.getData(DND_FILE_MIME)) as KitDragData;
			(cells[key] ??= []).push({
				uid: ++uidSeq,
				id: f.id,
				name: f.name,
				format: f.format,
				suffix: ''
			});
		} catch {
			/* 非文件表拖来的数据，忽略 */
		}
	}

	function removeItem(key: string, it: KitItem): void {
		if (playingUid === it.uid) {
			audio?.pause();
			playingUid = -1;
		}
		cells[key] = (cells[key] ?? []).filter((x) => x.uid !== it.uid);
	}

	function clearAll(): void {
		audio?.pause();
		playingUid = -1;
		cells = {};
	}

	/** 点 chip 播放钮：未播→播、播放中→暂停、暂停→继续（同文件表交互） */
	function togglePlay(it: KitItem): void {
		if (!audio) return;
		if (playingUid === it.uid) {
			if (audio.paused) void audio.play();
			else audio.pause();
			return;
		}
		playingUid = it.uid;
		audio.src = `/f/${encodeURIComponent(it.id)}`;
		void audio.play();
	}

	/** 打包下载：逐条拉取（同 id 去重）→ 流式 STORE 写入 → 落盘（复用整包下载的保存策略） */
	async function downloadZip(): Promise<void> {
		if (dlState === 'packing' || entries.length === 0) return;
		dlState = 'packing';
		dlDone = 0;
		dlTotal = entries.length;
		try {
			let handle: FileSystemFileHandle | null = null;
			try {
				handle = await window.showSaveFilePicker({
					suggestedName: `${t('kit.zipName')}.zip`,
					types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }]
				});
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') {
					dlState = 'idle'; // 用户取消保存对话框，不算失败
					return;
				}
				handle = null;
			}
			const writable = handle ? await handle.createWritable() : null;
			const chunks: Uint8Array[] = [];
			let writeChain = Promise.resolve();
			const zip = new Zip((err, dat) => {
				if (err) throw err;
				if (writable) writeChain = writeChain.then(() => writable.write(dat));
				else chunks.push(dat);
			});
			// 同一文件可能进多个格子：按 id 去重拉取（fetch 不带 Range → 200 全量）
			const bufCache = new Map<string, Promise<Uint8Array>>();
			const getBuf = (id: string): Promise<Uint8Array> => {
				let p = bufCache.get(id);
				if (!p) {
					p = fetch(`/f/${encodeURIComponent(id)}`).then(async (r) => {
						if (!r.ok) throw new Error(`HTTP ${r.status}`);
						return new Uint8Array(await r.arrayBuffer());
					});
					bufCache.set(id, p);
				}
				return p;
			};
			for (const e of entries) {
				const data = await getBuf(e.id);
				const entry = new ZipDeflate(e.target, { level: 0 }); // STORE 直通，CPU 仅 crc32
				zip.add(entry);
				entry.push(data, true);
				dlDone += 1;
			}
			zip.end(); // 同步流：返回时 central directory 已收入 chunks/写链
			if (writable) {
				await writeChain;
				await writable.close();
			} else {
				const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
				const a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = `${t('kit.zipName')}.zip`;
				a.click();
				URL.revokeObjectURL(a.href);
			}
			dlState = 'idle';
		} catch {
			dlState = 'error';
		}
	}

	onMount(() => {
		audio = new Audio();
		audio.preload = 'metadata';
		audio.addEventListener('play', () => (playingPaused = false));
		audio.addEventListener('pause', () => (playingPaused = true));
		audio.addEventListener('ended', () => (playingUid = -1));
		audio.addEventListener('error', () => (playingUid = -1));
		// 拖起文件表行时自动展开面板（types 在 dragstart 阶段已可读，getData 不行）。
		// setTimeout 延迟到拖拽会话建立后再改 DOM：dragstart 事件内同步增删节点
		// 会让 Chromium 直接放弃本次拖拽（表现为第一次拖没反应、第二次才好）
		const onDragStart = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes(DND_FILE_MIME)) setTimeout(() => (open = true), 0);
		};
		// 拖到一半取消（Esc / 释放在无效区）时清掉格子悬停高亮
		const onDragEnd = () => (overKey = '');
		window.addEventListener('dragstart', onDragStart);
		window.addEventListener('dragend', onDragEnd);
		return () => {
			window.removeEventListener('dragstart', onDragStart);
			window.removeEventListener('dragend', onDragEnd);
		};
	});
</script>

{#if !open}
	<!-- 收起态：右下角悬浮钮（GitHub 反馈钮左侧），badge 显示已放音效数 -->
	<button
		class="kit-fab"
		onclick={() => (open = true)}
		title={t('kit.title')}
		aria-label={t('kit.title')}
	>
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<rect x="1" y="1" width="6" height="6" rx="1.5" />
			<rect x="9" y="1" width="6" height="6" rx="1.5" />
			<rect x="1" y="9" width="6" height="6" rx="1.5" />
			<rect x="9" y="9" width="6" height="6" rx="1.5" />
		</svg>
		{#if itemCount > 0}
			<span class="fab-badge">{itemCount}</span>
		{/if}
	</button>
{:else}
	<div class="kit-panel" role="dialog" aria-label={t('kit.title')}>
		<div class="kit-bar">
			<span class="kit-name">{t('kit.title')}</span>
			{#if itemCount > 0}
				<span class="badge">{t('kit.count', { count: itemCount })}</span>
			{/if}
			<span class="kit-hint">{t('kit.hint')}</span>
			<div class="kit-actions">
				<button class="btn" disabled={itemCount === 0} onclick={clearAll}>
					{t('kit.clear')}
				</button>
				{#if dlState === 'packing'}
					<button class="btn primary" disabled>
						{t('download.packaging', { n: dlDone, total: dlTotal })}
					</button>
				{:else}
					<button
						class="btn primary"
						class:err={dlState === 'error'}
						disabled={itemCount === 0}
						title={dlState === 'error' ? t('download.failedHint') : ''}
						onclick={() => void downloadZip()}
					>
						{dlState === 'error' ? t('download.failedRetry') : t('kit.download')}
					</button>
				{/if}
				<button
					class="collapse"
					title={t('kit.collapse')}
					aria-label={t('kit.collapse')}
					onclick={() => (open = false)}
				>
					×
				</button>
			</div>
		</div>

		<div class="kit-grid">
			<div class="corner"></div>
			{#each COLS as col (col)}
				<div class="colhead">{col}</div>
			{/each}
			{#each ROWS as row (row)}
				<div class="rowhead">{row}</div>
				{#each COLS as col (col)}
					{@const key = `${row}/${col}`}
					<div
						class="cell"
						class:over={overKey === key}
						role="list"
						aria-label={`${row}-${col}`}
						ondragover={(e) => allowDrop(e, key)}
						ondragleave={(e) => leaveCell(e, key)}
						ondrop={(e) => drop(e, key)}
					>
						{#each cells[key] ?? [] as it (it.uid)}
							{@const target = `${row}-${col}${it.suffix}.${it.format}`}
							<div
								class="chip"
								role="listitem"
								class:dup={dupTargets.has(target)}
								class:playing={playingUid === it.uid}
								title={dupTargets.has(target) ? `${target} — ${t('kit.dupName')}` : target}
							>
								<button
									class="play"
									onclick={() => togglePlay(it)}
									aria-label={playingUid === it.uid && !playingPaused
										? t('action.pause')
										: t('action.play')}
								>
									{#if playingUid === it.uid && !playingPaused}
										<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
									{:else}
										▶
									{/if}
								</button>
								<span class="cname">{it.name}</span>
								<input
									class="suffix"
									value={it.suffix}
									inputmode="numeric"
									maxlength="3"
									placeholder="#"
									title={t('kit.suffix')}
									aria-label={t('kit.suffix')}
									oninput={(e) => {
										// 直接回写 DOM：清洗后与原值相同时 Svelte 不会刷新 input，残留非法字符
										const clean = e.currentTarget.value.replace(/\D/g, '');
										e.currentTarget.value = clean;
										it.suffix = clean;
									}}
								/>
								<button
									class="rm"
									title={t('kit.remove')}
									aria-label={t('kit.remove')}
									onclick={() => removeItem(key, it)}
								>
									×
								</button>
							</div>
						{:else}
							<span class="plus" aria-hidden="true">+</span>
						{/each}
					</div>
				{/each}
			{/each}
		</div>
	</div>
{/if}

<style>
	/* 收起态：右下角悬浮钮（GitHub 反馈钮 40px@right:16 的左侧 12px 处） */
	.kit-fab {
		position: fixed;
		right: 68px;
		bottom: 16px;
		z-index: 50;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
		border: 1px solid var(--accent-deep);
		background: var(--accent);
		color: var(--text);
		cursor: pointer;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
	.kit-fab:hover {
		background: var(--accent-deep);
	}
	.kit-fab svg {
		width: 18px;
		height: 18px;
		fill: currentColor;
	}

	.fab-badge {
		position: absolute;
		top: -5px;
		right: -5px;
		min-width: 17px;
		height: 17px;
		padding: 0 4px;
		border-radius: 999px;
		background: var(--accent-pink);
		border: 2px solid var(--bg-l1);
		color: #fff;
		font-size: 10px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* 展开态：右下角浮层（z-index 低于对话框 100、高于内容） */
	.kit-panel {
		position: fixed;
		right: 16px;
		bottom: 68px;
		z-index: 60;
		width: min(760px, calc(100vw - 32px));
		max-height: min(430px, calc(100vh - 150px));
		display: flex;
		flex-direction: column;
		background: var(--bg-l2);
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		box-shadow: 0 12px 40px rgb(0 0 0 / 0.45);
		overflow: hidden;
	}

	.kit-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 4px 10px;
		min-height: 40px;
		border-bottom: 1px solid var(--bg-l3);
	}

	.kit-name {
		flex: none;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
	}

	.badge {
		flex: none;
		padding: 0 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 25%, transparent);
		color: var(--accent-bright);
		font-size: 11px;
	}

	.kit-hint {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-faint);
		font-size: 12px;
	}

	.kit-actions {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.collapse {
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: var(--radius);
	}
	.collapse:hover {
		color: var(--text);
		background: var(--bg-l3);
	}

	.btn {
		padding: 4px 14px;
		border: 1px solid var(--bg-l3);
		border-radius: var(--radius);
		background: transparent;
		color: var(--text-dim);
		font-size: 12px;
		cursor: pointer;
		white-space: nowrap;
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
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.btn.err {
		border-color: var(--accent-pink);
		background: var(--accent-pink);
		color: var(--text);
	}

	.kit-grid {
		display: grid;
		grid-template-columns: 64px repeat(4, minmax(140px, 1fr));
		grid-template-rows: auto repeat(3, minmax(66px, auto));
		gap: 6px;
		padding: 8px 12px 12px;
		flex: 1;
		min-height: 0;
		overflow: auto;
	}

	.colhead {
		text-align: center;
		color: var(--accent-bright);
		font-size: 12px;
		font-weight: 600;
		padding-bottom: 2px;
	}

	.rowhead {
		align-self: center;
		text-align: right;
		padding-right: 8px;
		color: var(--text-dim);
		font-size: 13px;
	}

	.cell {
		min-width: 0;
		background: var(--bg-l1);
		border: 1px dashed var(--bg-l3);
		border-radius: var(--radius);
		padding: 4px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow-y: auto;
	}
	.cell.over {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-l1));
	}

	.plus {
		margin: auto;
		color: var(--text-faint);
		font-size: 20px;
		line-height: 1;
		user-select: none;
	}
	.cell.over .plus {
		color: var(--accent-bright);
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 2px 4px;
		border-radius: var(--radius);
		background: var(--bg-l3);
		font-size: 12px;
	}
	.chip.dup {
		outline: 1px solid var(--accent-pink);
	}
	.chip.playing {
		outline: 1px solid var(--accent);
	}

	.play {
		flex: none;
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--accent-bright);
		font-size: 9px;
		cursor: pointer;
		border-radius: var(--radius);
		padding: 0;
	}
	.play:hover {
		background: var(--bg-l1);
	}

	.cname {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text);
	}

	.suffix {
		flex: none;
		width: 26px;
		padding: 1px 3px;
		border: 1px solid var(--bg-l1);
		border-radius: var(--radius);
		background: var(--bg-l1);
		color: var(--accent-bright);
		font-size: 11px;
		text-align: center;
		font-family: inherit;
	}
	.suffix:focus {
		outline: none;
		border-color: var(--accent);
	}

	.rm {
		flex: none;
		width: 18px;
		height: 18px;
		border: none;
		background: transparent;
		color: var(--text-faint);
		font-size: 14px;
		line-height: 1;
		cursor: pointer;
		border-radius: var(--radius);
		padding: 0;
	}
	.rm:hover {
		color: var(--accent-pink);
		background: var(--bg-l1);
	}

	/* 播放指示：三根跳动条（FileTable 同款缩小版） */
	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 1.5px;
		height: 10px;
	}
	.eq i {
		width: 2px;
		background: var(--accent-pink);
		animation: eq 0.9s infinite ease-in-out alternate;
	}
	.eq i:nth-child(1) {
		height: 60%;
		animation-delay: -0.3s;
	}
	.eq i:nth-child(2) {
		height: 100%;
	}
	.eq i:nth-child(3) {
		height: 40%;
		animation-delay: -0.6s;
	}
	@keyframes eq {
		from {
			transform: scaleY(0.4);
		}
		to {
			transform: scaleY(1);
		}
	}
</style>
