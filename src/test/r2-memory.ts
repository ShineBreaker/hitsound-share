// 测试用 R2 适配器：内存 Map 模拟 R2Bucket 的最小面（put/head/get/list/delete）。
// - get 带 range 时：返回对象 size 为完整对象大小（R2 语义），body 只含区间字节
// - list 按 key 排序分页：truncated + cursor（cursor = 本页末 key，下次从其后开始）
// - calls 按方法名计数（put/head/get/list/delete），供子请求预算断言
import type { R2Bucket } from '@cloudflare/workers-types';

export interface MemoryR2 {
	bucket: R2Bucket;
	calls: Record<'put' | 'head' | 'get' | 'list' | 'delete', number>;
	/** 调用记录（'list:<prefix>' / 'get:<key>' / 'delete:<n>'），断言用 */
	ops: string[];
	/** 测试断言辅助：当前存在的 key 集 */
	keys(): string[];
	/** 测试断言辅助：读整个对象字节 */
	bytes(key: string): Uint8Array | undefined;
}

interface StoredObj {
	bytes: Uint8Array;
}

function toBytes(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	if (typeof v === 'string') return new TextEncoder().encode(v);
	if (v && typeof (v as Blob).arrayBuffer === 'function') {
		throw new Error('MemoryR2.put: Blob/Stream 请先在测试里转 Uint8Array');
	}
	throw new Error(`MemoryR2.put: 不支持的类型 ${typeof v}`);
}

export function createMemoryR2(): MemoryR2 {
	const store = new Map<string, StoredObj>();
	const calls: MemoryR2['calls'] = { put: 0, head: 0, get: 0, list: 0, delete: 0 };
	const ops: string[] = [];

	const headObj = (key: string, o: StoredObj) => ({
		key,
		size: o.bytes.length,
		etag: `mem-${o.bytes.length}`,
		uploaded: new Date(0),
		httpEtag: `"mem-${o.bytes.length}"`,
		checksums: {},
		storageClass: 'Standard',
		httpMetadata: {},
		customMetadata: {},
		writeHttpMetadata: () => ({})
	});

	const bucket = {
		async put(key: string, value: unknown): Promise<unknown> {
			calls.put += 1;
			const bytes = toBytes(value);
			store.set(key, { bytes });
			return headObj(key, store.get(key)!);
		},
		async head(key: string) {
			calls.head += 1;
			const o = store.get(key);
			return o ? headObj(key, o) : null;
		},
		async get(key: string, opts?: { range?: { offset?: number; length?: number } }) {
			calls.get += 1;
			ops.push(`get:${key}`);
			const o = store.get(key);
			if (!o) return null;
			let bytes = o.bytes;
			const r = opts?.range;
			if (r) bytes = o.bytes.subarray(r.offset ?? 0, (r.offset ?? 0) + (r.length ?? o.bytes.length));
			return {
				...headObj(key, o), // size = 完整对象大小（R2 range get 语义）
				body: new ReadableStream({
					start(c) {
						c.enqueue(bytes);
						c.close();
					}
				}),
				bodyUsed: false,
				arrayBuffer: async () => bytes.slice().buffer,
				text: async () => new TextDecoder().decode(bytes),
				json: async () => JSON.parse(new TextDecoder().decode(bytes)),
				blob: async () => new Blob([bytes as BlobPart])
			};
		},
		async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
			calls.list += 1;
			ops.push(`list:${opts?.prefix ?? ''}`);
			const prefix = opts?.prefix ?? '';
			const limit = opts?.limit ?? 1000;
			const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
			const start = opts?.cursor ? all.findIndex((k) => k > opts.cursor!) : 0;
			const from = start === -1 ? all.length : Math.max(0, start);
			const page = all.slice(from, from + limit);
			const truncated = from + limit < all.length;
			return {
				objects: page.map((k) => headObj(k, store.get(k)!)),
				truncated,
				cursor: truncated ? page[page.length - 1] : undefined,
				delimitedPrefixes: []
			};
		},
		async delete(keys: string | string[]): Promise<void> {
			calls.delete += 1;
			const list = Array.isArray(keys) ? keys : [keys];
			ops.push(`delete:${list.length}`);
			for (const k of list) store.delete(k);
		}
	};

	return {
		bucket: bucket as unknown as R2Bucket,
		calls,
		ops,
		keys: () => [...store.keys()].sort(),
		bytes: (key) => store.get(key)?.bytes
	};
}
