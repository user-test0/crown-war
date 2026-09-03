"""生成应用图标：深蓝底 + 金色皇冠"""
from PIL import Image, ImageDraw
import os

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角背景
    bg = (26, 28, 44)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size-1, size-1], radius=r, fill=bg)
    # 内圈光晕
    d.ellipse([size*0.12, size*0.12, size*0.88, size*0.88], fill=(43, 58, 103))
    # 皇冠
    gold = (255, 193, 7)
    gold_dark = (255, 143, 0)
    cx, cy = size/2, size/2
    w, h = size*0.56, size*0.42
    x0, y0 = cx - w/2, cy - h/2 + size*0.04
    # 三个尖
    pts = [
        (x0, y0 + h*0.75),
        (x0, y0 + h*0.15),
        (x0 + w*0.25, y0 + h*0.5),
        (cx, y0),
        (x0 + w*0.75, y0 + h*0.5),
        (x0 + w, y0 + h*0.15),
        (x0 + w, y0 + h*0.75),
    ]
    d.polygon(pts, fill=gold)
    # 底座
    d.rounded_rectangle([x0, y0 + h*0.72, x0 + w, y0 + h*0.95], radius=size*0.03, fill=gold_dark)
    # 宝石
    gem = (229, 57, 53)
    for gx in (x0 + w*0.25, cx, x0 + w*0.75):
        d.ellipse([gx - size*0.035, y0 + h*0.78 - size*0.035, gx + size*0.035, y0 + h*0.78 + size*0.035], fill=gem)
    return img

base = '/workspace/crown-war/android/app/src/main/res'
for folder, sz in [('mipmap-mdpi', 48), ('mipmap-hdpi', 72), ('mipmap-xhdpi', 96), ('mipmap-xxhdpi', 144), ('mipmap-xxxhdpi', 192)]:
    os.makedirs(f'{base}/{folder}', exist_ok=True)
    draw_icon(sz).save(f'{base}/{folder}/ic_launcher.png')
    print(f'{folder}: {sz}px')
print('图标生成完成')
