// 统一密钥读取：Pages 环境变量（platform.env）优先，本地 dev 兜底 process.env；
// 凭证只从环境读，绝不硬编码、不打印（Mimosa 约束）
export interface Secrets {
	OSU_CLIENT_ID: string;
	OSU_CLIENT_SECRET: string;
	SESSION_SECRET: string;
	ADMIN_OSU_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_ACCOUNT_ID: string;
	/** 可选：显式 OAuth 回调地址（默认取请求 origin + /api/auth/callback） */
	OSU_REDIRECT_URI: string;
}

export type SecretsKey = keyof Secrets;

export function getSecrets(platform: App.Platform | undefined): Partial<Secrets> {
	const bindings = platform?.env as Record<string, string | undefined> | undefined;
	const proc: Record<string, string | undefined> =
		typeof process !== 'undefined' ? process.env : {};
	const pick = (key: SecretsKey): string | undefined => {
		const v = bindings?.[key] ?? proc[key];
		return v && v.length > 0 ? v : undefined;
	};
	return {
		OSU_CLIENT_ID: pick('OSU_CLIENT_ID'),
		OSU_CLIENT_SECRET: pick('OSU_CLIENT_SECRET'),
		SESSION_SECRET: pick('SESSION_SECRET'),
		ADMIN_OSU_ID: pick('ADMIN_OSU_ID'),
		R2_ACCESS_KEY_ID: pick('R2_ACCESS_KEY_ID'),
		R2_SECRET_ACCESS_KEY: pick('R2_SECRET_ACCESS_KEY'),
		R2_ACCOUNT_ID: pick('R2_ACCOUNT_ID'),
		OSU_REDIRECT_URI: pick('OSU_REDIRECT_URI')
	};
}

/** 预签名所需的 R2 三项（getSecrets 的子集，凑齐即可签名） */
export type R2Secrets = Pick<Secrets, 'R2_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'>;

/** 上传链路凭证齐全（6 项必需；ADMIN_OSU_ID / OSU_REDIRECT_URI 可选不参与） */
export function uploadCapable(s: Partial<Secrets>): s is Partial<Secrets> & R2Secrets {
	return Boolean(
		s.OSU_CLIENT_ID &&
			s.OSU_CLIENT_SECRET &&
			s.SESSION_SECRET &&
			s.R2_ACCOUNT_ID &&
			s.R2_ACCESS_KEY_ID &&
			s.R2_SECRET_ACCESS_KEY
	);
}

/** R2 三项齐 → 预签名可用，否则 null（调用方回退 /api/blob 同源代理） */
export function pickR2Secrets(s: Partial<Secrets>): R2Secrets | null {
	return s.R2_ACCOUNT_ID && s.R2_ACCESS_KEY_ID && s.R2_SECRET_ACCESS_KEY
		? {
				R2_ACCOUNT_ID: s.R2_ACCOUNT_ID,
				R2_ACCESS_KEY_ID: s.R2_ACCESS_KEY_ID,
				R2_SECRET_ACCESS_KEY: s.R2_SECRET_ACCESS_KEY
			}
		: null;
}
