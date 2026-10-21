#!/usr/bin/env python3
"""Build the cockpit's bundled display fonts (build-time only; fontTools + brotli).

Sources (SIL OFL 1.1, downloaded once into SRC, never committed as binaries here):
  Orbitron[wght].ttf   https://github.com/google/fonts/tree/main/ofl/orbitron      RFN "Orbitron"
  RussoOne-Regular.ttf https://github.com/google/fonts/tree/main/ofl/russoone      RFN "Russo"
  SmileySans-Oblique.ttf https://github.com/atelier-anchor/smiley-sans (v2.0.1)    RFN "Smiley", "得意黑"
Subsetting/patching makes Modified Versions, so the output families are renamed
(MotuoNum / MotuoDisplay / MotuoHan) as the OFL requires; licenses ship alongside.

usage: python3 scripts/build-cockpit-fonts.py <source-dir>
"""
import hashlib, json, re, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

ROOT = Path(__file__).resolve().parents[1]
PROTO = ROOT / 'prototypes/motuo-v2'
OUT = PROTO / 'assets/fonts'
LATIN = ''.join(chr(c) for c in range(0x20, 0x7F)) + '°·—–×≈‹›→←−…“”‘’™•▶■□'
CJK = re.compile(r'[　-〿㐀-䶿一-鿿＀-￯—…·「-』]')


def page_text():
    """Every CJK character the cockpit can display (HTML, JS, CSS, native bridge)."""
    files = [*PROTO.glob('*.html'), *PROTO.glob('*.js'), *PROTO.glob('*.css'), ROOT / 'ios/Motuo/Cockpit/native-runtime.js']
    chars = set()
    for f in files:
        if f.name == 'ride-hud-preview.html':
            continue
        chars.update(CJK.findall(f.read_text(encoding='utf-8')))
    return chars


def gb2312_level1():
    """GB2312 level-1 hanzi (3755 most common characters) for dynamic native strings."""
    out = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def rename(font, family, style='Regular'):
    names = font['name']
    full = f'{family} {style}' if style != 'Regular' else family
    ps = (family + '-' + style).replace(' ', '')
    for rec in list(names.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            names.removeNames(nameID=rec.nameID)
    for nid, value in ((1, family), (2, style), (3, f'Motuo:{ps}'), (4, full), (6, ps)):
        names.setName(value, nid, 3, 1, 0x409)
        names.setName(value, nid, 1, 0, 0)
    note = 'Modified (subset/renamed) for the Motuo cockpit; see the accompanying OFL license.'
    names.setName(note, 10, 3, 1, 0x409)


def tabular_digits(font):
    """Equal advance widths for 0-9 with centred outlines (speed must not jitter)."""
    cmap, hmtx, glyf = font.getBestCmap(), font['hmtx'], font['glyf']
    digits = [cmap[ord(c)] for c in '0123456789']
    width = max(hmtx[g][0] for g in digits)
    for g in digits:
        adv, lsb = hmtx[g]
        dx = (width - adv) // 2
        glyph = glyf[g]
        if dx and glyph.numberOfContours:
            glyph.coordinates.translate((dx, 0))
            glyph.recalcBounds(glyf)
        hmtx[g] = (width, lsb + dx)
    return width


def write_subset(font, text, out, features=('kern', 'liga')):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = list(features)
    opts.name_IDs = ['*']; opts.name_languages = ['*']; opts.notdef_outline = True
    opts.drop_tables += ['DSIG']
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(out)
    return out


def codepoints(path):
    return sorted(TTFont(path).getBestCmap().keys())


def main(src):
    src = Path(src)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {'built_by': 'scripts/build-cockpit-fonts.py', 'fonts': []}

    num = instancer.instantiateVariableFont(TTFont(src / 'Orbitron[wght].ttf'), {'wght': 800})
    digit_width = tabular_digits(num)
    rename(num, 'MotuoNum')
    write_subset(num, LATIN, OUT / 'motuo-num.woff2')

    disp = TTFont(src / 'RussoOne-Regular.ttf'); rename(disp, 'MotuoDisplay')
    write_subset(disp, LATIN, OUT / 'motuo-display.woff2')

    page = page_text()
    han_text = ''.join(sorted(page | set(gb2312_level1()))) + LATIN
    han = TTFont(src / 'SmileySans-Oblique.ttf'); rename(han, 'MotuoHan', 'Oblique')
    write_subset(han, han_text, OUT / 'motuo-han.woff2')

    han_cps = set(codepoints(OUT / 'motuo-han.woff2'))
    missing = sorted(c for c in page if ord(c) not in han_cps)
    for name, origin, rfn in (('motuo-num.woff2', 'Orbitron (wght 800, tabular digits)', 'Orbitron'),
                              ('motuo-display.woff2', 'Russo One', 'Russo'),
                              ('motuo-han.woff2', 'Smiley Sans Oblique 得意黑 v2.0.1', 'Smiley / 得意黑')):
        data = (OUT / name).read_bytes()
        manifest['fonts'].append({'file': name, 'origin': origin, 'reserved_font_name': rfn, 'bytes': len(data),
                                  'sha256': hashlib.sha256(data).hexdigest(), 'codepoints': len(codepoints(OUT / name))})
    manifest['page_cjk_chars'] = len(page)
    manifest['page_cjk_missing'] = missing
    manifest['digit_advance'] = digit_width
    manifest['total_bytes'] = sum(f['bytes'] for f in manifest['fonts'])
    (OUT / 'fonts-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in manifest.items() if k != 'fonts'}, ensure_ascii=False))
    for f in manifest['fonts']:
        print(f"  {f['file']}: {f['bytes']:,} bytes, {f['codepoints']} codepoints")
    if missing:
        sys.exit(f'Missing glyphs for page text: {"".join(missing)}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/tmp/motuo-fonts/src')
