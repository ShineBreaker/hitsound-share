// runUpload：fake fetch 编排 manifest/PUT/done 三段交互
// 覆盖：happy path、同 hash 只 PUT 一次、503 重试、403 → put_failed、
// 附加模式 done 404 package_not_found → append_gone、zip 解包跳过非音频计数
import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { runUpload, UploadError, type UploadEvent } from './upload-pipeline';
import { sha256Hex } from './upload-pipeline';

const wavBytes = (tag: number): Uint8Array => {
	// 最小合法 RIFF/WAVE 头（fmt chunk），后面填静音字节
	const d = new Uint8Array(64).fill(tag);
	[0x52, 0x49, 0x46, 0x46].forEach((b, i) => (d[i] = b)); // RIFF
	[0x57, 0x41, 0x56, 0x45].forEach((b, i) => (d[8 + i] = b)); // WAVE
	return d;
};

const decodeMeta = async () => null; // 测试环境不解码
const loadWasm = async () => new ArrayBuffer(0); // zip 用不到

interface Req {
	url: string;
	method: string;
	body?: unknown;
	status: number;
	payload?: unknown;
	times?: number; // 前 N 次按 status 响应，之后按 afterStatus（默认 200）
	afterStatus?: number;
	afterPayload?: unknown;
}

/** 脚本化 fake fetch：按 (method, url 前缀) 匹配，支持前几次失败再成功 */
function scriptedFetch(rules: Req[]): { fetch: typeof fetch; seen: Req[] } {
	const seen: Req[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body;
		const rule = rules.find(
			(r) => r.method === method && (url === r.url || url.startsWith(`${r.url}?`))
		);
		if (!rule) throw new Error(`未编排的请求 ${method} ${url}`);
		seen.push({ ...rule, body });
		rule.times = (rule.times ?? Infinity) - 1;
		if (rule.times >= 0) {
			return new Response(JSON.stringify(rule.payload ?? {}), { status: rule.status });
		}
		return new Response(JSON.stringify(rule.afterPayload ?? rule.payload ?? {}), {
			status: rule.afterStatus ?? 200
		});
	}) as typeof fetch;
	return { fetch: fetchImpl, seen };
}

const collect = () => {
	const events: UploadEvent[] = [];
	return { events, onEvent: (e: UploadEvent) => events.push(e) };
};

const targetNew = { kind: 'new', name: 'grp' } as const;

describe('runUpload', () => {
	it('happy path：manifest → PUT → done，相位与日志顺序正确', async () => {
		const hash = await sha256Hex(wavBytes(1));
		const { fetch, seen } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: { packageId: 'p1', missing: [{ hash, url: 'https://r2.test/put?sig=x' }], existingCount: 0 }
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 200 },
			{ url: '/api/upload/done', method: 'POST', status: 200 }
		]);
		const { events, onEvent } = collect();
		await runUpload(
			{ name: 'a.wav', bytes: wavBytes(1) },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			onEvent
		);
		const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
		expect(phases).toEqual(['parsing', 'uploading', 'finalizing']);
		// PUT 体是原始字节
		const put = seen.find((r) => r.method === 'PUT');
		expect(put).toBeDefined();
		expect((put!.body as Uint8Array).length).toBe(64);
	});

	it('同 hash 的两个文件 → manifest 去重后只 PUT 一次', async () => {
		const same = wavBytes(7);
		const hash = await sha256Hex(same);
		const zip = zipSync({ 'a.wav': same, 'b.wav': same.slice() }); // 内容相同 → 同 hash
		const { fetch, seen } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: {
					packageId: 'p2',
					missing: [{ hash, url: 'https://r2.test/put?sig=y' }], // 服务端按 hash 去重
					existingCount: 0
				}
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 200 },
			{ url: '/api/upload/done', method: 'POST', status: 200 }
		]);
		await runUpload(
			{ name: 'pack.zip', bytes: zip },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			collect().onEvent
		);
		expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(1);
	});

	it('PUT 503 → 按 retryDelaysMs 重试后成功', async () => {
		const hash = await sha256Hex(wavBytes(2));
		const { fetch, seen } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: { packageId: 'p3', missing: [{ hash, url: 'https://r2.test/put' }], existingCount: 0 }
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 503, times: 1, payload: { e: 'x' } },
			{ url: '/api/upload/done', method: 'POST', status: 200 }
		]);
		await runUpload(
			{ name: 'a.wav', bytes: wavBytes(2) },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			collect().onEvent
		);
		expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(2); // 503 + 重试成功
	});

	it('PUT 403（不可重试）→ UploadError put_failed', async () => {
		const hash = await sha256Hex(wavBytes(3));
		const { fetch } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: { packageId: 'p4', missing: [{ hash, url: 'https://r2.test/put' }], existingCount: 0 }
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 403, times: 10 }
		]);
		const err = await runUpload(
			{ name: 'a.wav', bytes: wavBytes(3) },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			collect().onEvent
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(UploadError);
		expect((err as UploadError).code).toBe('put_failed');
	});

	it('附加模式 done 404 package_not_found → append_gone', async () => {
		const hash = await sha256Hex(wavBytes(4));
		const { fetch } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: { packageId: 'S', missing: [{ hash, url: 'https://r2.test/put' }], appending: true }
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 200 },
			{ url: '/api/upload/done', method: 'POST', status: 404, times: 10, payload: { error: 'package_not_found' } }
		]);
		const err = await runUpload(
			{ name: 'a.wav', bytes: wavBytes(4) },
			{ kind: 'append', packageId: 'T' },
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			collect().onEvent
		).catch((e: unknown) => e);
		expect((err as UploadError).code).toBe('append_gone');
	});

	it('zip 解包：非音频文件计入 skipped 事件', async () => {
		const hash = await sha256Hex(wavBytes(5));
		const zip = zipSync({
			'a.wav': wavBytes(5),
			'readme.txt': new Uint8Array([104, 105]),
			'pic.png': new Uint8Array([0x89, 0x50])
		});
		const { fetch } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 200,
				payload: { packageId: 'p5', missing: [{ hash, url: 'https://r2.test/put' }] }
			},
			{ url: 'https://r2.test/put', method: 'PUT', status: 200 },
			{ url: '/api/upload/done', method: 'POST', status: 200 }
		]);
		const { events, onEvent } = collect();
		await runUpload(
			{ name: 'pack.zip', bytes: zip },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			onEvent
		);
		const skipped = events.find((e) => e.type === 'skipped');
		expect(skipped).toEqual({ type: 'skipped', count: 2 });
	});

	it('manifest 失败 → 服务端 error 透传为 code', async () => {
		const { fetch } = scriptedFetch([
			{
				url: '/api/upload',
				method: 'POST',
				status: 400,
				times: 10,
				payload: { error: 'too_many_entries' }
			}
		]);
		const err = await runUpload(
			{ name: 'a.wav', bytes: wavBytes(6) },
			targetNew,
			{ fetch, loadWasm, decodeMeta, retryDelaysMs: [0, 0] },
			collect().onEvent
		).catch((e: unknown) => e);
		expect((err as UploadError).code).toBe('too_many_entries');
	});
});
