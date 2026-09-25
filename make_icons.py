"""生成 App 图标（纯标准库，无需装任何东西）
设计：橙色底 + 白色五角星，与原生版的一致。
iOS 会自动套圆角，所以这里出的是满幅方形图。
"""
import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
SIZES = [180, 192, 512]
SS = 4  # 超采样倍数，用来做抗锯齿

BG = (0xF9, 0x73, 0x16)      # 橙色
FG = (0xFF, 0xFF, 0xFF)      # 白色


def star_polygon(cx, cy, outer_r, inner_r, points=5, rotation=-90.0):
    verts = []
    step = 180.0 / points
    angle = rotation
    for _ in range(points * 2):
        r = outer_r if len(verts) % 2 == 0 else inner_r
        rad = math.radians(angle)
        verts.append((cx + r * math.cos(rad), cy + r * math.sin(rad)))
        angle += step
    return verts


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def render(size):
    poly = star_polygon(size / 2.0, size / 2.0 + size * 0.01,
                        outer_r=size * 0.315, inner_r=size * 0.135)

    rows = []
    inv = 1.0 / (SS * SS)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            hit = 0
            for sy in range(SS):
                fy = py + (sy + 0.5) / SS
                for sx in range(SS):
                    fx = px + (sx + 0.5) / SS
                    if point_in_poly(fx, fy, poly):
                        hit += 1
            a = hit * inv
            row += bytes((
                int(BG[0] + (FG[0] - BG[0]) * a),
                int(BG[1] + (FG[1] - BG[1]) * a),
                int(BG[2] + (FG[2] - BG[2]) * a),
            ))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return (struct.pack(">I", len(data)) + body +
                struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8bit truecolor RGB
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
        rows = render(s)
        p = os.path.join(OUT_DIR, f"icon-{s}.png")
        n = write_png(p, s, rows)
        print(f"  icon-{s}.png  {s}x{s}  {n:,} bytes")


if __name__ == "__main__":
    print("生成图标中（超采样 %dx，稍等）…" % SS)
    main()
    print("完成。")
