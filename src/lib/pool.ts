// 并发池：限并发遍历（上传 PUT、下载拉取、核验抽查共用；IO 等待不占 CPU，
// 限流是避免一次打满 R2/连接）。首个 reject 后停止调度新任务，等在途任务收尾后抛出首个错误
export async function mapPool<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>
): Promise<void> {
	let next = 0;
	let failed = false;
	let firstErr: unknown;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (!failed && next < items.length) {
			const i = next++;
			try {
				await fn(items[i], i);
			} catch (e) {
				if (!failed) {
					failed = true;
					firstErr = e;
				}
			}
		}
	});
	await Promise.all(workers);
	if (failed) throw firstErr;
}

// MessageChannel 宏任务让出：setTimeout(0) 每次 ~4ms，MC 端口 ~0.05ms
// （SSR/测试环境无 MessageChannel 时退 setTimeout）
const mc = typeof MessageChannel === 'undefined' ? null : new MessageChannel();
const mcQueue: Array<() => void> = [];
if (mc) {
	mc.port1.onmessage = () => mcQueue.shift()?.();
}

/** 交还主线程一次的宏任务：长同步循环（CRC/峰值扫描）分片间调用防帧冻结 */
export function yieldMain(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (mc) {
		mcQueue.push(resolve);
		mc.port2.postMessage(null);
	} else {
		setTimeout(resolve, 0);
	}
	return promise;
}
