#!/usr/local/opt/python@3.12/bin/python3.12
"""讯飞AI学习机应用中心 自动上架

一条命令:
    ./publish.py 1.2.3 "修复xxx"

无登录态自动开浏览器让你扫码/输密码, 保存后继续.
APK: $XUNFEI_APK 或 ~/AutoRelease/xunfei/app.apk
"""
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

STATE = Path.home() / ".config" / "xunfei" / "storage_state.json"
APK = Path(os.environ.get("XUNFEI_APK") or Path.home() / "AutoRelease/xunfei/app.apk")
HOME = "https://xxj.xunfei.cn/app-open-platform/#/home"
DUMP = Path("/tmp/xunfei_upload_page.html")


def main(version: str, notes: str) -> None:
    if not APK.is_file():
        sys.exit(f"APK 不存在: {APK}")
    STATE.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        b = p.chromium.launch(headless=False)
        ctx = b.new_context(storage_state=str(STATE) if STATE.is_file() else None)
        page = ctx.new_page()
        page.goto(HOME)

        if not STATE.is_file():
            print("→ 浏览器登录, 完成后回终端按 Enter")
            input()
            ctx.storage_state(path=str(STATE))
            print(f"✓ storage_state 已存: {STATE}")

        print(f"版本 {version} | APK {APK.name} | 备注 {notes!r}")
        print("→ 手动: 应用管理→选应用→更新, 停在能上传APK的页, 回车 dump HTML")
        input()

        # ponytail: selector 未知先 dump. 补完 selector 后此段替换为
        # page.set_input_files('input[type=file]', str(APK)) 等实操
        DUMP.write_text(page.content())
        print(f"✓ dump: {DUMP}  ← 把这文件发我补 selector")
        input("按 Enter 关闭.")
        b.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("用法: publish.py <version> [notes]")
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")
