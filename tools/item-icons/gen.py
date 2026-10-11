import sys, re, json
sys.path.insert(0, '.')
from emap import M
# Usage: npm pack @tabler/icons@3.35.0 && tar xzf tabler-icons-*.tgz, then:
#   python3 gen.py <path to package/icons/outline/> ../../js/data/item-icons.js
D = sys.argv[1].rstrip('/') + '/'
def to_paths(svg):
    out = []
    for tag, attrs in re.findall(r'<(path|circle|rect|line|polyline|polygon|ellipse)\b([^>]*)/?>', svg):
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs))
        if a.get('stroke') == 'none' and a.get('fill') == 'none': continue  # tabler's invisible bounding box
        if tag == 'path': d = a['d']
        elif tag == 'circle':
            cx, cy, r = float(a['cx']), float(a['cy']), float(a['r'])
            d = f'M{cx-r} {cy}a{r} {r} 0 1 0 {2*r} 0a{r} {r} 0 1 0 {-2*r} 0'
        elif tag == 'rect':
            x, y, w, h = float(a.get('x', 0)), float(a.get('y', 0)), float(a['width']), float(a['height']); r = float(a.get('rx', 0))
            d = f'M{x+r} {y}h{w-2*r}a{r} {r} 0 0 1 {r} {r}v{h-2*r}a{r} {r} 0 0 1 {-r} {r}h{-(w-2*r)}a{r} {r} 0 0 1 {-r} {-r}v{-(h-2*r)}a{r} {r} 0 0 1 {r} {-r}z'
        else: raise SystemExit(f'unhandled {tag}')
        out.append({'d': d, 'fill': True} if a.get('fill') == 'currentColor' else d)
    return out
icons = {}
EXTRA = ['pokeball', 'mask', 'confetti', 'ice-cream', 'balloon']
for name in sorted(set(M.values()) | set(EXTRA)):
    icons[name] = to_paths(open(D + name + '.svg').read())
emoji = {k: v for k, v in M.items()}
js = ('// Flat item pictures: each hunt item\'s emoji maps to a line icon from Tabler Icons\n'
      '// (MIT License, Copyright (c) 2020-2025 Paweł Kuna, https://tabler.io/icons). Generated; edit the map, not the paths.\n'
      'export const ITEM_ICON_PATHS = ' + json.dumps(icons, ensure_ascii=False, separators=(',', ':')) + ';\n\n'
      'export const EMOJI_ICON = ' + json.dumps(emoji, ensure_ascii=False, separators=(',', ':')) + ';\n')
open(sys.argv[2], 'w').write(js)
print(len(icons), 'icons,', len(js), 'bytes')
