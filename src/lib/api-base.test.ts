// API 客户端层：URL 拼接 / 凭证注入 / 三支分派——打 mock fetch 断言入参，不走网络。
// 状态复位：afterEach clearConnection（模块级 $state 跨用例共享）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	API_BASE_KEY,
	GATE_TOKEN_KEY,
	apiFetch,
	absoluteApiUrl,
	fetchIssuedUrl,
	loginUrl,
	needsDesktopSetup,
	setApiBase,
	clearConnection,
	setGateToken
} from './api-base.svelte';

let calls: Array<{ input: unknown; init?: RequestInit }>;

beforeEach(() => {
	calls = [];
	vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response('{}', { status: 200 });
	});
});

afterEach(() => {
	clearConnection();
	vi.unstubAllGlobals();
});

describe('setApiBase', () => {
	it('非法值 throw bad_url', () => {
		expect(() => setApiBase('ftp://x')).toThrow('bad_url');
		expect(() => setApiBase('https://')).toThrow('bad_url');
		expect(() => setApiBase('')).toThrow('bad_url');
	});

	it('规范化：trim + 去尾部斜杠', async () => {
		setApiBase('  https://api.example.com/  ');
		await apiFetch('/x');
		expect(calls[0].input).toBe('https://api.example.com/x');
	});
});

describe('apiFetch', () => {
	it("base='' 时相对路径原样请求且 credentials same-origin（无 header）", async () => {
		await apiFetch('/api/tree');
		expect(calls).toHaveLength(1);
		expect(calls[0].input).toBe('/api/tree');
		expect(calls[0].init?.credentials).toBe('same-origin');
		expect(calls[0].init?.headers).toBeUndefined();
	});

	it('base 设置后拼接 URL + credentials include + 注入 x-hs-gate（init 其余透传）', async () => {
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		await apiFetch('/api/tree', { cache: 'reload' });
		expect(calls[0].input).toBe('https://api.example.com/api/tree');
		expect(calls[0].init?.credentials).toBe('include');
		expect(calls[0].init?.cache).toBe('reload');
		expect(new Headers(calls[0].init?.headers).get('x-hs-gate')).toBe('tok-1');
	});

	it('绝对 http(s) URL（R2 预签名）原样 fetch，不加 header/credentials', async () => {
		setGateToken('tok-1');
		await apiFetch('https://bucket.r2.cloudflarestorage.com/blobs/ab/h.wav?X-Sig=1', {
			method: 'PUT',
			body: 'x'
		});
		expect(calls[0].input).toBe('https://bucket.r2.cloudflarestorage.com/blobs/ab/h.wav?X-Sig=1');
		expect(calls[0].init).toEqual({ method: 'PUT', body: 'x' }); // init 原样透传
	});
});

describe('fetchIssuedUrl', () => {
	it('① 相对路径 → apiFetch 语义（base 拼接 + x-hs-gate）', async () => {
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		await fetchIssuedUrl('/api/blob/ab/hash.wav');
		expect(calls[0].input).toBe('https://api.example.com/api/blob/ab/hash.wav');
		expect(new Headers(calls[0].init?.headers).get('x-hs-gate')).toBe('tok-1');
	});

	it('② API 域绝对 URL → 剥 base 走 apiFetch（带 x-hs-gate + credentials）', async () => {
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		await fetchIssuedUrl('https://api.example.com/api/blob/ab/hash.wav?fallback=1');
		expect(calls[0].input).toBe('https://api.example.com/api/blob/ab/hash.wav?fallback=1');
		expect(new Headers(calls[0].init?.headers).get('x-hs-gate')).toBe('tok-1');
		expect(calls[0].init?.credentials).toBe('include');
	});

	it('③ R2 域绝对 URL → 裸 fetch，不带 header/credentials', async () => {
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		await fetchIssuedUrl('https://bucket.r2.cloudflarestorage.com/blobs/ab/h.wav?X-Sig=1');
		expect(calls[0].input).toBe('https://bucket.r2.cloudflarestorage.com/blobs/ab/h.wav?X-Sig=1');
		expect(calls[0].init?.headers).toBeUndefined();
		expect(calls[0].init?.credentials).toBeUndefined();
	});
});

describe('absoluteApiUrl', () => {
	it("base 空 + 无 token → 原样相对路径", () => {
		expect(absoluteApiUrl('/f/abc')).toBe('/f/abc');
	});

	it("'/f/' 前缀自动带 hs_gate query（Audio.src / 单文件下载导航无法带 header）", () => {
		setApiBase('https://api.example.com');
		setGateToken('tok 1'); // 含空格验证编码
		expect(absoluteApiUrl('/f/abc/download')).toBe(
			'https://api.example.com/f/abc/download?hs_gate=tok%201'
		);
	});

	it('非 /f/ 路径默认不带，显式 withGate=true 强制带', () => {
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		expect(absoluteApiUrl('/api/auth/login')).toBe('https://api.example.com/api/auth/login');
		expect(absoluteApiUrl('/api/auth/login', true)).toBe(
			'https://api.example.com/api/auth/login?hs_gate=tok-1'
		);
	});
});

describe('loginUrl', () => {
	it('base 空且无 token → 纯相对路径无 query（同源现状）', () => {
		expect(loginUrl()).toBe('/api/auth/login');
	});

	it('base 非空无 token → 仅 hs_origin 单参数（URLSearchParams 组装，非手拼 &）', () => {
		vi.stubGlobal('location', { origin: 'http://127.0.0.1:8798' });
		setApiBase('https://api.example.com');
		const url = loginUrl();
		expect(url.startsWith('https://api.example.com/api/auth/login?')).toBe(true);
		const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
		expect(q.get('hs_origin')).toBe('http://127.0.0.1:8798');
		expect([...q.keys()]).toEqual(['hs_origin']);
	});

	it('token 存在且 base 非空 → hs_gate + hs_origin 双参数', () => {
		vi.stubGlobal('location', { origin: 'http://127.0.0.1:8798' });
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		const q = new URLSearchParams(loginUrl().split('?')[1]);
		expect(q.get('hs_gate')).toBe('tok-1');
		expect(q.get('hs_origin')).toBe('http://127.0.0.1:8798');
	});
});

describe('needsDesktopSetup（桌面首启引导遮罩判定）', () => {
	it('非 Tauri 环境 → false（base 空也不引导，Web 版零行为差异）', () => {
		expect(needsDesktopSetup()).toBe(false);
	});

	it('__TAURI_INTERNALS__ 存在 + base 空 → true（首启引导）', () => {
		vi.stubGlobal('__TAURI_INTERNALS__', {});
		expect(needsDesktopSetup()).toBe(true);
	});

	it('__TAURI__ 存在同样生效', () => {
		vi.stubGlobal('__TAURI__', {});
		expect(needsDesktopSetup()).toBe(true);
	});

	it('Tauri 环境 + base 已配置 → false（已连接不再引导）', () => {
		vi.stubGlobal('__TAURI_INTERNALS__', {});
		setApiBase('https://api.example.com');
		expect(needsDesktopSetup()).toBe(false);
	});
});

describe('localStorage 持久化（连接设置的保存路径）', () => {
	it('setApiBase/setGateToken 写入两键，clearConnection 双清', () => {
		const store = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k)
		});
		setApiBase('https://api.example.com');
		setGateToken('tok-1');
		expect(store.get(API_BASE_KEY)).toBe('https://api.example.com');
		expect(store.get(GATE_TOKEN_KEY)).toBe('tok-1');
		clearConnection();
		expect(store.has(API_BASE_KEY)).toBe(false);
		expect(store.has(GATE_TOKEN_KEY)).toBe(false);
	});
});
