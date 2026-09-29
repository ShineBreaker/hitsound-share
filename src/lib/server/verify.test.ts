// verifyFreshBlobs：小集合 ranged GET / 大集合 list+抽查 两条路径的核验行为与预算
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryR2, type MemoryR2 } from '../../test/r2-memory';
import { verifyFreshBlobs, type FreshBlob } from './verify';
import { blobKey } from './media';

const WAV_HEAD = [0x52, 0x49, 0x46, 0x46]; // RIFF
const h = (n: number) => n.toString(16).padStart(64, '0');

let r2: MemoryR2;

function wavBytes(size: number): Uint8Array {
	const d = new Uint8Array(size);
	WAV_HEAD.forEach((b, i) => (d[i] = b));
	return d;
}

async function putWav(hash: string, size: number): Promise<void> {
	await r2.bucket.put(blobKey(hash, 'wav'), wavBytes(size));
}

beforeEach(() => {
	r2 = createMemoryR2();
});

describe('verifyFreshBlobs', () => {
	it('0 个 blob：不打 R2', async () => {
		expect(await verifyFreshBlobs(r2.bucket, [])).toEqual([]);
		expect(r2.calls.get + r2.calls.list).toBe(0);
	});

	it('小集合：缺失 / 大小不符 / 魔数不符 各记 bad', async () => {
		const okH = h(1), missH = h(2), sizeH = h(3), magicH = h(4);
		await putWav(okH, 100);
		await putWav(sizeH, 200); // 声明 100，实存 200
		const badMagic = wavBytes(100).fill(0); // 全 0，非 RIFF
		await r2.bucket.put(blobKey(magicH, 'wav'), badMagic);

		const blobs: FreshBlob[] = [
			{ hash: okH, ext: 'wav', size: 100 },
			{ hash: missH, ext: 'wav', size: 100 }, // 无对象
			{ hash: sizeH, ext: 'wav', size: 100 },
			{ hash: magicH, ext: 'wav', size: 100 }
		];
		const bad = await verifyFreshBlobs(r2.bucket, blobs);
		expect(new Set(bad)).toEqual(new Set([missH, sizeH, magicH]));
		// 小集合走 ranged get，不 list
		expect(r2.calls.get).toBe(4);
		expect(r2.calls.list).toBe(0);
	});

	it('大集合（>24）前缀 ≤16：按 blobs/<pp>/ 前缀分页，不全量扫', async () => {
		// 30 个 blob 共用 2 个前缀（hash 前两位 '00' / '01'）
		const blobs: FreshBlob[] = [];
		for (let i = 0; i < 30; i++) {
			const hash = `${i % 2 === 0 ? '00' : '01'}${String(i).padStart(62, '0')}`;
			blobs.push({ hash, ext: 'wav', size: 100 });
			await putWav(hash, 100);
		}
		// 一个无关前缀下的对象，前缀扫描不应触达（行为上只校验 list 调用前缀）
		await putWav(`ff${'9'.repeat(62)}`, 100);

		const bad = await verifyFreshBlobs(r2.bucket, blobs);
		expect(bad).toEqual([]);
		const listOps = r2.ops.filter((o) => o.startsWith('list:'));
		expect(listOps.sort()).toEqual(['list:blobs/00/', 'list:blobs/01/']);
	});

	it('大集合前缀 >16：回退全量 blobs/ 分页', async () => {
		const blobs: FreshBlob[] = [];
		for (let i = 0; i < 30; i++) {
			const hash = `${i.toString(16).padStart(2, '0')}${String(i).padStart(62, '0')}`; // 30 个不同前缀
			blobs.push({ hash, ext: 'wav', size: 100 });
			await putWav(hash, 100);
		}
		const bad = await verifyFreshBlobs(r2.bucket, blobs);
		expect(bad).toEqual([]);
		expect(r2.ops.filter((o) => o.startsWith('list:'))).toEqual(['list:blobs/']);
		// 魔数抽查最多 16 次 get
		expect(r2.calls.get).toBeLessThanOrEqual(16);
	});

	it('大集合大小缺失记 bad（list 无对象）', async () => {
		const blobs: FreshBlob[] = [];
		for (let i = 0; i < 30; i++) {
			const hash = `${i % 2 === 0 ? '00' : '01'}${String(i).padStart(62, '0')}`;
			blobs.push({ hash, ext: 'wav', size: 100 });
			if (i !== 5) await putWav(hash, 100); // 第 5 个不落对象
		}
		const bad = await verifyFreshBlobs(r2.bucket, blobs);
		expect(bad).toEqual([blobs[5].hash]);
	});
});
