// Player：stub Audio 全局，验证 toggle/seek/独占性/pendingSeek/ended 复位
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from './player.svelte';

/** 事件驱动的假 Audio：play/pause 触发对应事件，loadedmetadata/ended 由测试手动派发 */
class FakeAudio {
	src = '';
	paused = true;
	currentTime = 0;
	duration = 8;
	preload = '';
	private ls = new Map<string, Array<() => void>>();
	addEventListener(type: string, fn: () => void): void {
		const list = this.ls.get(type) ?? [];
		list.push(fn);
		this.ls.set(type, list);
	}
	emit(type: string): void {
		for (const fn of this.ls.get(type) ?? []) fn();
	}
	play(): Promise<void> {
		this.paused = false;
		this.emit('play');
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
		this.emit('pause');
	}
}

let lastAudio: FakeAudio;

// Player.ensure() 在首次 toggle 时才 new Audio()；每个用例前重挂 stub
beforeEach(() => {
	vi.stubGlobal(
		'Audio',
		class extends FakeAudio {
			constructor() {
				super();
				lastAudio = this;
			}
		}
	);
});

afterEach(() => vi.unstubAllGlobals());

describe('Player', () => {
	it('toggle：未播→播、播放中→暂停、暂停→继续', () => {
		const p = new Player();
		p.toggle('f1', '/f/f1', 8);
		expect(p.current).toBe('f1');
		expect(p.paused).toBe(false);
		expect(lastAudio.src).toBe('/f/f1');
		p.toggle('f1', '/f/f1', 8); // 暂停
		expect(p.paused).toBe(true);
		expect(p.current).toBe('f1');
		p.toggle('f1', '/f/f1', 8); // 继续
		expect(p.paused).toBe(false);
	});

	it('切换 key：换 src 并直接播新曲目', () => {
		const p = new Player();
		p.toggle('f1', '/f/f1');
		p.toggle('f2', '/f/f2');
		expect(p.current).toBe('f2');
		expect(lastAudio.src).toBe('/f/f2');
		expect(p.paused).toBe(false);
	});

	it('seek 非当前 key：先播，loadedmetadata 后按比例跳', () => {
		const p = new Player();
		p.seek('f1', '/f/f1', 0.5, 10);
		expect(p.current).toBe('f1');
		expect(p.paused).toBe(false);
		expect(lastAudio.currentTime).toBe(0); // metadata 未就绪不跳
		lastAudio.emit('loadedmetadata');
		expect(lastAudio.currentTime).toBe(5); // 0.5 × 10s
	});

	it('seek 当前 key：立即按 durationS 跳', () => {
		const p = new Player();
		p.toggle('f1', '/f/f1', 10);
		p.seek('f1', '/f/f1', 0.25, 10);
		expect(lastAudio.currentTime).toBe(2.5);
	});

	it('ended → 复位（current=null, progress=0）', () => {
		const p = new Player();
		p.toggle('f1', '/f/f1');
		lastAudio.emit('ended');
		expect(p.current).toBeNull();
		expect(p.progress).toBe(0);
	});

	it('kit 与文件 key 互斥：同一 Audio，切换即独占', () => {
		const p = new Player();
		p.toggle('file-uuid-1', '/f/file-uuid-1');
		expect(p.current).toBe('file-uuid-1');
		p.toggle('kit:3', '/f/file-uuid-9'); // 组装面板播放 → 顶掉文件表
		expect(p.current).toBe('kit:3');
		expect(lastAudio.src).toBe('/f/file-uuid-9');
	});

	it('stop：暂停 + 复位', () => {
		const p = new Player();
		p.toggle('kit:1', '/f/x');
		p.stop();
		expect(p.current).toBeNull();
		expect(p.paused).toBe(true);
	});
});
