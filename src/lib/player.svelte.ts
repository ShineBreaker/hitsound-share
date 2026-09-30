// 全局共享播放器：单个 Audio 元素按需播放（文件表行与组装面板 chip 共用同一实例，
// key 命名空间区分来源——'file.id' 与 'kit:<uid>'，故两处永不同时播放）。
// Audio 在首次使用时惰性创建，SSR/测试环境（无 Audio 全局）下安全 no-op
export class Player {
	current = $state<string | null>(null); // 当前 key（file.id 或 kit:<uid>）
	paused = $state(true);
	progress = $state(0); // 0-1

	private audio: HTMLAudioElement | null = null;
	private pendingSeek: number | null = null; // 待 metadata 就绪后应用的跳播比例
	private durationHint: number | null = null; // 元数据时长（流式 mp3 的 audio.duration 可能是 Infinity）
	private rafId = 0; // 播放中的 progress 刷新帧（0 = 未在跑）

	private ensure(): HTMLAudioElement | null {
		if (typeof Audio === 'undefined') return null;
		if (!this.audio) {
			const a = new Audio();
			a.preload = 'auto'; // 连续缓冲：默认 metadata 可能播一半欠载
			const update = () => {
				const dur = this.durationHint ?? a.duration;
				this.progress = Number.isFinite(dur) && dur > 0 ? a.currentTime / dur : 0;
			};
			// rAF 逐帧刷进度（timeupdate 仅 ~4Hz，波形进度条跳变）；只在播放中跑。
			// 测试/SSR 无 requestAnimationFrame → 进度退回 timeupdate/seeked 驱动
			const raf = typeof requestAnimationFrame === 'undefined' ? null : requestAnimationFrame;
			const tick = () => {
				update();
				this.rafId = raf && !a.paused && !a.ended ? raf(tick) : 0;
			};
			a.addEventListener('play', () => {
				this.paused = false;
				if (raf && !this.rafId) this.rafId = raf(tick);
			});
			a.addEventListener('pause', () => {
				this.paused = true;
				update(); // 暂停即落地当前进度
			});
			a.addEventListener('ended', () => this.reset());
			a.addEventListener('seeked', update); // 跳播完成后进度立即到位
			a.addEventListener('timeupdate', update); // 后台标签页 rAF 被节流时的兜底
			// 播放失败（blob 缺失等）：复位，不留假播放态
			a.addEventListener('error', () => this.reset());
			a.addEventListener('loadedmetadata', () => {
				if (this.pendingSeek != null) {
					const dur = this.durationHint ?? a.duration;
					if (Number.isFinite(dur) && dur > 0) a.currentTime = this.pendingSeek * dur;
				}
				this.pendingSeek = null;
			});
			this.audio = a;
		}
		return this.audio;
	}

	private reset(): void {
		this.current = null;
		this.durationHint = null;
		this.pendingSeek = null;
		this.progress = 0;
	}

	/** 未播 → 播；当前 key 播放中 → 暂停、暂停中 → 继续 */
	toggle(key: string, src: string, durationS?: number): void {
		const a = this.ensure();
		if (!a) return;
		if (this.current === key) {
			if (a.paused) void a.play();
			else a.pause();
			return;
		}
		this.current = key;
		this.durationHint = durationS ?? null;
		this.pendingSeek = null;
		this.progress = 0;
		a.src = src;
		void a.play();
	}

	/** 当前 key 直接跳；别的 key 先播、metadata 就绪后再按比例跳 */
	seek(key: string, src: string, ratio: number, durationS?: number): void {
		const a = this.ensure();
		if (!a) return;
		if (this.current !== key) {
			this.toggle(key, src, durationS);
			this.pendingSeek = ratio;
			return;
		}
		const dur = durationS ?? this.durationHint ?? a.duration;
		if (Number.isFinite(dur) && dur > 0) a.currentTime = ratio * dur;
	}

	/** 停掉当前播放（调用方负责只在 current 属于自己时调） */
	stop(): void {
		this.audio?.pause();
		this.reset();
	}
}

export const player = new Player();
