// 桌面壳唯一职责：装载 frontendDist 静态产物（tauri.conf.json > build.frontendDist）。
// 不注册命令、不加插件——前端零改动依赖 __TAURI_INTERNALS__ 存在性判定桌面形态，
// 业务逻辑全在 WebView 内（登录态走 x-hs-session 头，见 docs/desktop.md）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
