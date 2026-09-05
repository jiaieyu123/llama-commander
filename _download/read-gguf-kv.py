# -*- coding: utf-8 -*-
"""流式读取 GGUF 头部 KV，打印 head/attention/维度相关键值（调研用）。"""
import struct, sys

def r(fl, fmt):
    sz = struct.calcsize(fmt)
    b = fl.read(sz)
    if len(b) != sz:
        raise EOFError('premature eof at fmt ' + fmt)
    return struct.unpack(fmt, b)[0]

def rstr(fl):
    n = r(fl, '<Q')
    return fl.read(n).decode('utf-8', 'replace')

def rval(fl, t):
    if t == 8:
        return rstr(fl)
    if t == 7:
        return bool(r(fl, 'B'))
    if t == 0: return r(fl, 'B')
    if t == 1: return r(fl, 'b')
    if t == 2: return r(fl, '<H')
    if t == 3: return r(fl, '<h')
    if t == 4: return r(fl, '<I')
    if t == 5: return r(fl, '<i')
    if t == 6: return r(fl, '<f')
    if t == 10: return r(fl, '<Q')
    if t == 11: return r(fl, '<q')
    if t == 12: return r(fl, '<d')
    if t == 9:
        at = r(fl, '<I')
        n = r(fl, '<Q')
        return [rval(fl, at) for _ in range(n)]
    raise ValueError('unknown type %d' % t)

def main(path):
    with open(path, 'rb') as f:
        magic = f.read(4)
        if magic != b'GGUF':
            print('not gguf'); return
        ver = r(f, '<I')
        n_tensor = r(f, '<Q')
        n_kv = r(f, '<Q')
        print(f'GGUF v{ver} tensors={n_tensor} kv={n_kv}')
        show = ('head', 'attention', 'key_length', 'value_length', 'kv', 'dim', 'block_count', 'embedding_length')
        for i in range(n_kv):
            try:
                key = rstr(f)
                t = r(f, '<I')
                val = rval(f, t)
                low = key.lower()
                if any(k in low for k in show):
                    sval = str(val)
                    if len(sval) > 800: sval = sval[:800] + ' …'
                    print(f'  {key} = {sval}')
            except Exception as e:
                print(f'  [stop at kv#{i} "{key}"]: {e}')
                break
        # ---- tensor 名/形状（可选：第二个参数=tensor 关键词） ----
        import sys as _s
        want = _s.argv[2] if len(_s.argv) > 2 else None
        if want:
            tnames = []
            for i in range(n_tensor):
                try:
                    name = rstr(f)
                    nd = r(f, '<I')
                    dims = [r(f, '<Q') for _ in range(nd)]
                    tt = r(f, '<I')
                    off = r(f, '<Q')
                    if want.lower() in name.lower():
                        tnames.append((name, dims))
                except Exception as e:
                    print(f'  [tensor stop {i}]: {e}'); break
            # 打印每层首个样本与统计
            seenLayers = {}
            for name, dims in tnames:
                import re as _re
                mm = _re.match(r'blk\.(\d+)\.', name)
                L = mm.group(1) if mm else name
                if L not in seenLayers: seenLayers[L] = []
                if len(seenLayers[L]) < 3: seenLayers[L].append((name, dims))
            ks = sorted(seenLayers.keys(), key=lambda x: (len(x), x))
            for L in ks[:6]:
                for name, dims in seenLayers[L]:
                    print(f'  TENSOR {name} dims={dims}')

if __name__ == '__main__':
    main(sys.argv[1])
