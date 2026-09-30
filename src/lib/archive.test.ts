// 7z 解包深测：fixture 由 7z-wasm 自产（a → x 自洽，无系统依赖）。
// rar 分支不做 wasm 级测试（node 下需读包内 unrar.wasm，行为与 7z 同构，由浏览器路径覆盖）。
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import SevenZip, { type SevenZipModule } from '7z-wasm';
import { readArchive, ArchiveError, type ArchiveWasmLoaders } from './archive';

const require = createRequire(import.meta.url);

async function szWasm(): Promise<ArrayBuffer> {
	const b = readFileSync(require.resolve('7z-wasm/7zz.wasm'));
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const loaders: ArchiveWasmLoaders = { unrar: szWasm, sz: szWasm }; // unrar 分支不触达

function call(sz: SevenZipModule, args: string[]): void {
	try {
		sz.callMain(args);
	} catch (e) {
		// 正常退出经 Emscripten 以 ExitStatus 冒出；其余异常照抛（创建失败即测试失败）
		if (!(e instanceof Error && e.name === 'ExitStatus')) throw e;
	}
}

/** 在 /work 下铺文件（逐级建目录）后以相对路径打包——保留目录层级 */
async function make7z(files: Record<string, Uint8Array>, args: string[] = []): Promise<Uint8Array> {
	const sz = await SevenZip({ wasmBinary: await szWasm(), print: () => {}, printErr: () => {} });
	sz.FS.mkdir('/work');
	for (const [path, data] of Object.entries(files)) {
		const dir = `/work/${path.slice(0, path.lastIndexOf('/'))}`;
		let cur = '';
		for (const seg of dir.split('/').filter(Boolean)) {
			cur += `/${seg}`;
			try {
				sz.FS.mkdir(cur);
			} catch {
				/* 已存在 */
			}
		}
		sz.FS.writeFile(`/work/${path}`, data);
	}
	sz.FS.chdir('/work');
	call(sz, ['a', '/out.7z', ...Object.keys(files), ...args]);
	return sz.FS.readFile('/out.7z');
}

describe('readArchive（7z）', () => {
	it('解包：中文与子目录路径、字节数正确（保留层级，剥顶层前缀在 pipeline 层做）', async () => {
		const d = await make7z({
			'我的皮肤/normal-hitnormal.wav': new Uint8Array(8).fill(1),
			'我的皮肤/子类/soft-hitclap.wav': new Uint8Array(8).fill(2)
		});
		const files = await readArchive(d, loaders);
		expect(files.map((f) => f.path).sort()).toEqual([
			'我的皮肤/normal-hitnormal.wav',
			'我的皮肤/子类/soft-hitclap.wav'
		]);
		expect(files.find((f) => f.path.endsWith('hitclap.wav'))?.data).toEqual(
			new Uint8Array(8).fill(2)
		);
	});

	it('加密头（-mhe=on）→ encrypted', async () => {
		const d = await make7z({ 'a.wav': new Uint8Array(8).fill(1) }, ['-psecret', '-mhe=on']);
		const err = await readArchive(d, loaders).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ArchiveError);
		expect((err as ArchiveError).code).toBe('encrypted');
	});

	it('仅内容加密 → encrypted', async () => {
		const d = await make7z({ 'a.wav': new Uint8Array(8).fill(1) }, ['-psecret']);
		const err = await readArchive(d, loaders).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ArchiveError);
		expect((err as ArchiveError).code).toBe('encrypted');
	});

	it('损坏（魔数 + 噪声）→ corrupt', async () => {
		const bad = new Uint8Array(300).fill(0xff);
		bad.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
		const err = await readArchive(bad, loaders).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ArchiveError);
		expect((err as ArchiveError).code).toBe('corrupt');
	});

	it('非压缩包内容 → unknown_format', async () => {
		const err = await readArchive(new Uint8Array([1, 2, 3]), loaders).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ArchiveError);
		expect((err as ArchiveError).code).toBe('unknown_format');
	});
});
