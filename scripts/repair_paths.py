from pathlib import Path
import re

root = Path(r"D:\IPT\Riversight-A-Solid-Waste-Detection-and-Real-Time-Incident-Notification-System")
admin_dir = root / "lib" / "admin"
monitoring_dir = root / "lib" / "monitoring"

for html_file in list(admin_dir.glob("*.html")) + list(monitoring_dir.glob("*.html")):
    text = html_file.read_text(encoding="utf-8")

    if html_file.parent == admin_dir:
        text = text.replace('../css/', '../../css/admin/')
        text = text.replace('../assets/', '../../assets/')
        text = text.replace('admin_js/admin-login.js', '../../js/admin/admin-login.js')
        text = text.replace('href="../lib/', 'href="./')
    else:
        text = text.replace('../css/', '../../css/monitoring/')
        text = text.replace('../assets/', '../../assets/')

    if '<link rel="stylesheet" href="../../css/shared/global.css">' not in text:
        text = text.replace('<meta name="viewport" content="width=device-width, initial-scale=1.0">', '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<link rel="stylesheet" href="../../css/shared/global.css">', 1)

    if '<script src="../../js/shared/global.js"></script>' not in text:
        text = text.replace('</body>', '<script src="../../js/shared/global.js"></script>\n</body>', 1)

    text = text.replace("window.location.href = 'Admin-Dashboard.html'", "window.location.href = './Admin-Dashboard.html'")
    text = text.replace('window.location.href = "Admin-Dashboard.html"', 'window.location.href = "./Admin-Dashboard.html"')

    html_file.write_text(text, encoding='utf-8')
