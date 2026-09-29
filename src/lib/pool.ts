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
