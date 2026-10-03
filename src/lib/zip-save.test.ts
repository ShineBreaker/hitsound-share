// packZip：unzipSync 校验产物（名字/字节正确）、同 key 只 load 一次、并发上限、错误传播；
// saveZip：桌面（Tauri）模式跳过 picker 走内存 Blob 兜底、非桌面仍走 FS Access 流式写
import { describe, it, expect, vi, afterEach } from 'vitest';
import { unzipSync } from 'fflate';
import { packZip, saveZip } from './zip-save';

function collect(): { chunks: Uint8Array[]; write: (c: Uint8Array) => void } {
	const chunks: Uint8Array[] = [];
	return { chunks, write: (c) => void chunks.push(c) };
}

function unzip(chunks: Uint8Array[]): Record<string, Uint8Array> {
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const zip = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		zip.set(c, off);
		off += c.length;
	}
	return unzipSync(zip);
}

describe('packZip', () => {
	it('产物 zip 可解：名字与字节正确', async () => {
		const { chunks, write } = collect();
		const body1 = new Uint8Array([1, 2, 3, 4]);
		const body2 = new Uint8Array([9, 8, 7]);
		await packZip({
			entries: [
				{ path: 'a/one.wav', key: 'k1' },
				{ path: 'dir with space/#&,.wav', key: 'k2' },
				{ path: 'b/two.wav', key: 'k1' } // 同 key 另一条目
			],
			load: async (key) => (key === 'k1' ? body1 : body2),
			write
		});
		const out = unzip(chunks);
		expect(Object.keys(out).sort()).toEqual(['a/one.wav', 'b/two.wav', 'dir with space/#&,.wav']);
		expect([...out['a/one.wav']]).toEqual([1, 2, 3, 4]);
		expect([...out['b/two.wav']]).toEqual([1, 2, 3, 4]); // 同 key 内容一致
		expect([...out['dir with space/#&,.wav']]).toEqual([9, 8, 7]);
	});

	it('同 key 只 load 一次（去重）', async () => {
		const { write } = collect();
		const loads: string[] = [];
		await packZip({
			entries: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.wav`, key: 'shared' })),
			load: async (key) => {
				loads.push(key);
				return new Uint8Array([7]);
			},
			write,
			concurrency: 3
		});
		expect(loads).toEqual(['shared']);
	});

	it('并发上限生效', async () => {
		const { write } = collect();
		let inflight = 0;
		let maxInflight = 0;
		await packZip({
			entries: Array.from({ length: 24 }, (_, i) => ({ path: `f${i}.wav`, key: `k${i}` })),
			load: async () => {
				inflight++;
				maxInflight = Math.max(maxInflight, inflight);
				await new Promise((r) => setTimeout(r, 1));
				inflight--;
				return new Uint8Array([1]);
			},
			write,
			concurrency: 4
		});
		expect(maxInflight).toBeLessThanOrEqual(4);
	});

	it('load 拒绝 → packZip 拒绝', async () => {
		const { write } = collect();
		const boom = new Error('HTTP 404');
		await expect(
			packZip({
				entries: [{ path: 'x.wav', key: 'k' }],
				load: () => Promise.reject(boom),
				write
			})
		).rejects.toBe(boom);
	});

	it('write 第 2 次拒绝 → packZip 拒绝且不再空拉剩余 key', async () => {
		const boom = new Error('disk full');
		let writeCalls = 0;
		const loads: string[] = [];
		await expect(
			packZip({
				entries: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.wav`, key: `k${i}` })),
				load: async (key) => {
					loads.push(key);
					return new Uint8Array([1]);
				},
				write: () => {
					writeCalls++;
					if (writeCalls === 2) return Promise.reject(boom);
				},
				concurrency: 1 // 串行：write 失败一旦被捕获，下一轮 zipErr 检查即中止调度
			})
		).rejects.toBe(boom);
		expect(loads.length).toBeLessThan(10);
	});

	it('onProgress 汇报 done/total', async () => {
		const { write } = collect();
		const seen: Array<[number, number]> = [];
		await packZip({
			entries: [
				{ path: 'a', key: 'k1' },
				{ path: 'b', key: 'k2' }
			],
			load: async () => new Uint8Array([0]),
			write,
			onProgress: (d, t) => seen.push([d, t])
		});
		expect(seen).toHaveLength(2);
		expect(seen[1]).toEqual([2, 2]);
	});
});

describe('saveZip', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('桌面模式跳过 picker，走内存 Blob + a.download 兜底', async () => {
		// picker 存在但永不 resolve（Tauri WebView 已知坑）：被调用则本用例超时失败
		let pickerCalls = 0;
		vi.stubGlobal('window', {
			showSaveFilePicker: () => {
				pickerCalls++;
				return new Promise(() => {});
			}
		});
		vi.stubGlobal('__TAURI_INTERNALS__', {});
		const clicks: string[] = [];
		const anchor = {
			href: '',
			download: '',
			click: () => void clicks.push(anchor.download)
		};
		vi.stubGlobal('document', { createElement: () => anchor });
		vi.stubGlobal('URL', {
			createObjectURL: () => 'blob:test',
			revokeObjectURL: () => {}
		});

		const r = await saveZip('pkg', {
			entries: [{ path: 'a.wav', key: 'k' }],
			load: async () => new Uint8Array([1, 2])
		});
		expect(r).toBe('saved');
		expect(pickerCalls).toBe(0); // 关键断言：桌面检测短路 FS Access 路径
		expect(clicks).toEqual(['pkg.zip']);
		// 等待兜底路径 revoke 定时器触发完（避免 unstub 后回调打到 node 原生 URL）
		await new Promise((res) => setTimeout(res, 5));
	});

	it('非桌面模式仍走 FS Access picker（现状不回归）', async () => {
		let pickerCalls = 0;
		const writes: Uint8Array[] = [];
		vi.stubGlobal('window', {
			showSaveFilePicker: async () => {
				pickerCalls++;
				return {
					createWritable: async () => ({
						write: (c: Uint8Array) => void writes.push(c),
						close: async () => {},
						abort: async () => {}
					})
				};
			}
		});

		const r = await saveZip('pkg', {
			entries: [{ path: 'a.wav', key: 'k' }],
			load: async () => new Uint8Array([3])
		});
		expect(r).toBe('saved');
		expect(pickerCalls).toBe(1);
		// 单条目：本地头 + 数据 + 中央目录/EOCD 尾 = 3 段流式写
		expect(writes.length).toBe(3);
	});
});
