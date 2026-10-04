// Windows 发布构建不弹控制台窗口（Linux 无效但无害，官方模板标准形态）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hitsound_share_lib::run()
}
