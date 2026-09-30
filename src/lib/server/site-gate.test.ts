// 站点访问密码门 deep module：密码源优先级（库记录 > 环境变量初始密码 > 未启用）、
// 改密生效、解锁 cookie 签发验证与失效
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestD1, type TestD1 } from '../../test/d1-sqlite';
import {
	validGatePassword,
	getGateState,
	setGatePassword,
	checkGatePassword,
	issueUnlockValue,
	verifyUnlockValue,
	isSiteUnlocked
} from './site-gate';

let d1: TestD1;

beforeEach(() => {
	d1 = createTestD1();
});

describe('validGatePassword', () => {
	it('4-100 字符且非全空白才合法', () => {
		expect(validGatePassword('abcd')).toBe(true);
		expect(validGatePassword('a'.repeat(100))).toBe(true);
		expect(validGatePassword('abc')).toBe(false); // 过短
		expect(validGatePassword('a'.repeat(101))).toBe(false); // 过长
		expect(validGatePassword('   ')).toBe(false); // 全空白
		expect(validGatePassword('')).toBe(false);
	});
});

describe('密码源优先级', () => {
	it('库记录与初始密码皆无 → 未启用', async () => {
		const state = await getGateState(d1.db);
		expect(state.enabled).toBe(false);
		expect(state.hash).toBeNull();
		// 未启用：无 cookie 也放行（isSiteUnlocked 组合语义）
		expect(await isSiteUnlocked(d1.db, undefined)).toBe(true);
	});

	it('环境变量初始密码 → 启用；同密码可解锁', async () => {
		const state = await getGateState(d1.db, 'init-pass-1');
		expect(state.enabled).toBe(true);
		expect(state.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await checkGatePassword(d1.db, 'init-pass-1', 'init-pass-1')).toBe(true);
		expect(await checkGatePassword(d1.db, 'wrong-pass', 'init-pass-1')).toBe(false);
		// 未启用（没传初始密码）时校验恒 false
		expect(await checkGatePassword(d1.db, 'init-pass-1')).toBe(false);
	});

	it('库记录优先于环境变量（管理员改密后 env 不再生效）', async () => {
		const hash = await setGatePassword(d1.db, 'rotated-pass');
		const state = await getGateState(d1.db, 'init-pass-1');
		expect(state.hash).toBe(hash);
		expect(await checkGatePassword(d1.db, 'rotated-pass', 'init-pass-1')).toBe(true);
		expect(await checkGatePassword(d1.db, 'init-pass-1', 'init-pass-1')).toBe(false);
	});

	it('改密幂等覆盖；新旧交替生效', async () => {
		await setGatePassword(d1.db, 'first-pass');
		expect(await checkGatePassword(d1.db, 'first-pass')).toBe(true);

		await setGatePassword(d1.db, 'second-pass');
		expect(await checkGatePassword(d1.db, 'second-pass')).toBe(true);
		expect(await checkGatePassword(d1.db, 'first-pass')).toBe(false);
	});
});

describe('解锁 cookie', () => {
	it('签发值可被当前 hash 验证；篡改/空值拒绝', async () => {
		const hash = (await getGateState(d1.db, 'init-pass-1')).hash!;
		const value = await issueUnlockValue(hash);
		expect(value).toMatch(/^[0-9a-f]{16}\.[A-Za-z0-9_-]+$/);
		expect(await verifyUnlockValue(value, hash)).toBe(true);

		expect(await verifyUnlockValue(undefined, hash)).toBe(false);
		expect(await verifyUnlockValue('nonsense', hash)).toBe(false);
		expect(await verifyUnlockValue(`${value}x`, hash)).toBe(false);
		// 指纹段换成别的 hash 前缀（HMAC 消息已绑定 fp，签名对不上）
		expect(await verifyUnlockValue(`deadbeefdeadbeef${value.slice(16)}`, hash)).toBe(false);
	});

	it('改密后旧解锁值立即失效（旧会话全站作废）', async () => {
		const oldHash = (await getGateState(d1.db, 'init-pass-1')).hash!;
		const oldValue = await issueUnlockValue(oldHash);
		expect(await verifyUnlockValue(oldValue, oldHash)).toBe(true);

		const newHash = await setGatePassword(d1.db, 'rotated-pass');
		expect(await verifyUnlockValue(oldValue, newHash)).toBe(false);
		expect(await verifyUnlockValue(await issueUnlockValue(newHash), newHash)).toBe(true);
	});

	it('isSiteUnlocked：启用且 cookie 有效 → true（1 条子请求）；cookie 无效 → false', async () => {
		const hash = (await getGateState(d1.db, 'init-pass-1')).hash!;
		expect(await isSiteUnlocked(d1.db, undefined, 'init-pass-1')).toBe(false);

		const value = await issueUnlockValue(hash);
		const before = d1.calls;
		expect(await isSiteUnlocked(d1.db, value, 'init-pass-1')).toBe(true);
		expect(d1.calls).toBe(before + 1); // 仅 settings 主键 SELECT
	});
});
