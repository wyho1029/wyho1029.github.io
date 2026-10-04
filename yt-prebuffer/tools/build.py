"""產生插件 icon 同打包 zip。

跑法：python3 yt-prebuffer/tools/build.py
- icons/：藍色圓角方格 + 白色「向下箭咀」，純 Python 畫（唔使 PIL）
- yt-prebuffer.zip：將 extension/ 打包，檔案時間固定，內容冇改 zip 就唔會變
"""
import os
import struct
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXT = os.path.join(ROOT, 'extension')
ZIP = os.path.join(ROOT, 'yt-prebuffer.zip')

BG_TOP, BG_BOTTOM = (0x3A, 0x8D, 0xF0), (0x15, 0x5F, 0xC8)
WHITE = (255, 255, 255)


def inside(x, y):
    """座標 0..1，回傳 (喺背景入面?, 喺白色圖案入面?)"""
    r = 0.22                                  # 圓角
    cx, cy = min(max(x, r), 1 - r), min(max(y, r), 1 - r)
    in_bg = (x - cx) ** 2 + (y - cy) ** 2 <= r * r and 0 <= x <= 1 and 0 <= y <= 1
    shaft = 0.43 <= x <= 0.57 and 0.18 <= y <= 0.50
    head = 0.46 <= y <= 0.70 and abs(x - 0.5) <= (0.70 - y) * 1.05
    bar = 0.24 <= x <= 0.76 and 0.76 <= y <= 0.85
    return in_bg, in_bg and (shaft or head or bar)


def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg = fg = 0
            for sy in range(ss):
                for sx in range(ss):
                    b, f = inside((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)
                    bg += b
                    fg += f
            n = ss * ss
            t = py / max(size - 1, 1)
            base = [round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)]
            a = bg / n
            if bg:
                k = fg / bg                      # 白色佔背景幾多
                rgb = [round(base[i] * (1 - k) + WHITE[i] * k) for i in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(a * 255)])
        rows.append(row)
    return rows


def png(rows):
    h, w = len(rows), len(rows[0]) // 4
    raw = b''.join(b'\x00' + bytes(r) for r in rows)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def build_icons():
    os.makedirs(os.path.join(EXT, 'icons'), exist_ok=True)
    for size in (16, 32, 48, 128):
        with open(os.path.join(EXT, 'icons', f'icon{size}.png'), 'wb') as f:
            f.write(png(render(size)))


def build_zip():
    files = []
    for dirpath, _, names in os.walk(EXT):
        for n in names:
            files.append(os.path.relpath(os.path.join(dirpath, n), EXT))
    with zipfile.ZipFile(ZIP, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(files):
            info = zipfile.ZipInfo('yt-prebuffer/' + rel.replace(os.sep, '/'), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(EXT, rel), 'rb') as f:
                z.writestr(info, f.read())
    print('已打包', ZIP, len(files), '個檔案')


if __name__ == '__main__':
    build_icons()
    build_zip()
