"""生成 App 图标（纯标准库，不装任何东西）
设计：深蓝对角渐变底 + 白色四角星（带蓝色光晕），和界面配色一致。
iOS 会自己套圆角，所以这里出满幅方形图。
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
SIZES = [180, 192, 512]
SS = 4  # 超采样倍数（抗锯齿）

TOP = (0x25, 0x63, 0xEB)   # 亮蓝
BOT = (0x06, 0x0F, 0x26)   # 深海军蓝
GLOW = (0x9C, 0xC8, 0xFF)  # 光晕
CORE = (0xFF, 0xFF, 0xFF)  # 星形本体


def sparkle(cx, cy, outer, inner, rotation=-90.0):
    """四角星：4 个外角 + 4 个内角"""
    verts = []
    for i in range(8):
        r = outer if i % 2 == 0 else inner
        ang = math.radians(rotation + i * 45.0)
        verts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return verts


def inside(x, y, poly):
    hit = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                hit = not hit
        j = i
    return hit


def mix(c1, c2, t):
    return (c1[0] + (c2[0] - c1[0]) * t,
            c1[1] + (c2[1] - c1[1]) * t,
            c1[2] + (c2[2] - c1[2]) * t)


def render(size):
    cx = cy = size / 2.0
    star = sparkle(cx, cy - size * 0.005, size * 0.295, size * 0.088)
    glow = sparkle(cx, cy - size * 0.005, size * 0.425, size * 0.165)

    rows = []
    inv = 1.0 / (SS * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            a_star = 0
            a_glow = 0
            for sy in range(SS):
                fy = py + (sy + 0.5) / SS
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    if inside(fx, fy, star):
                        a_star += 1
                    if inside(fx, fy, glow):
                        a_glow += 1
            a_star *= inv
            a_glow *= inv

            # 对角渐变底
            t = (px + py) / (2.0 * size)
            col = mix(TOP, BOT, t)
            # 叠光晕，再叠星形
            col = mix(col, GLOW, a_glow * 0.26)
            col = mix(col, CORE, a_star)

            row += bytes((int(col[0]), int(col[1]), int(col[2])))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body +
                struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", header) +
           chunk(b"IDAT", zlib.compress(raw, 9)) +
           chunk(b"IEND", b""))

    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        n = write_png(os.path.join(OUT_DIR, "icon-%d.png" % s), s, render(s))
        print("  icon-%d.png  %dx%d  %s bytes" % (s, s, s, format(n, ",")))


if __name__ == "__main__":
    print("生成深蓝图标中（%dx 超采样）…" % SS)
    main()
    print("完成。")
