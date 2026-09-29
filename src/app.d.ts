import type { R2Bucket, D1Database, Cache } from '@cloudflare/workers-types';

declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {}
		interface PageData {}
		/** Cloudflare Pages 运行时注入的 bindings（与 wrangler.toml 对应） */
		interface Platform {
			env?: {
				HITSOUND_FILES: R2Bucket;
				DB: D1Database;
			};
			context: {
				waitUntil(promise: Promise<unknown>): void;
			};
			caches: { default: Cache };
		}
	}
}

export {};
