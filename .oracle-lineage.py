import json, subprocess, glob, os, collections

D = os.path.expanduser('~/.dsh/sessions/--Users-lansterzhang-Documents-dsh-plugins-sapi-budget--')

def events(sid):
    p = os.path.join(D, sid, 'session.v4.jsonl.zstd')
    if not os.path.exists(p): return []
    out = subprocess.run(['zstd','-dc',p], capture_output=True).stdout.decode('utf-8','replace')
    evs = []
    for line in out.splitlines():
        line = line.strip()
        if not line: continue
        try: evs.append(json.loads(line))
        except Exception: pass
    return evs

def header(sid):
    for e in events(sid)[:3]:
        h = e.get('header') or (e if 'id' in e else None)
        if h and 'id' in h: return h
    return {}

# Build parent -> children from headers
parents = {}
for sid in os.listdir(D):
    h = header(sid)
    if h.get('id') == sid:
        parents[sid] = h.get('parentSession')

def own_buckets(sid):
    b = collections.Counter()
    models = collections.Counter()
    for e in events(sid):
        if e.get('type') != 'assistant/message': continue
        d = e.get('data') or {}
        u = d.get('usage')
        if not isinstance(u, dict):
            # fall back to last usage chunk in stream
            for rec in reversed(d.get('stream') or []):
                if isinstance(rec, dict) and rec.get('type') == 'chunk':
                    c = rec.get('chunk') or {}
                    if c.get('type') == 'usage' and isinstance(c.get('usage'), dict):
                        u = c['usage']; break
        if not isinstance(u, dict): continue
        b['input'] += u.get('inputTokens') or 0
        b['output'] += u.get('outputTokens') or 0
        b['cacheRead'] += u.get('cacheReadTokens') or 0
        b['cacheWrite'] += u.get('cacheWriteTokens') or 0
        b['requests'] += 1
        src = (d.get('message') or {}).get('source') or {}
        if src.get('model'): models[src['model']] += 1
    return b, models

def children(sid):
    return [s for s, p in parents.items() if p == sid]

def subtree(sid, seen=None):
    seen = seen or set()
    if sid in seen: return collections.Counter()
    seen.add(sid)
    b, _ = own_buckets(sid)
    total = collections.Counter(b)
    for c in children(sid):
        total += subtree(c, seen)
    return total

ROOT = 'session-ea8afcd1-3b43-4dc5-9974-f3029f638c67'
b, models = own_buckets(ROOT)
print('ROOT own buckets   :', dict(b))
print('ROOT models        :', dict(models))
kids = children(ROOT)
print('direct children    :', len(kids))
for k in kids:
    kb, km = own_buckets(k)
    print(f'  {k[:12]} own={dict(kb)} models={dict(km)}')
st = subtree(ROOT)
print('SUBTREE total      :', dict(st))

# Price it with the live catalog under a couple of groups.
import urllib.request
def get(u):
    return json.load(urllib.request.urlopen(u, timeout=20))
pricing = get('https://aispot.swj0227.icu/api/pricing')
status  = get('https://aispot.swj0227.icu/api/status')
grp     = get('https://aispot.swj0227.icu/api/user/groups')
sdata = status.get('data') or status
grupo = {}
for k,v in (pricing.get('group_ratio') or {}).items(): grupo[k]=v
for k,v in ((grp.get('data') or {}) if isinstance(grp.get('data'), dict) else {}).items():
    if isinstance(v, dict) and 'ratio' in v: grupo[k]=v['ratio']
quota = sdata.get('quota_per_unit') or 500000

def price(model, group, buckets):
    row = next((r for r in (pricing.get('data') or []) if r.get('model_name')==model), None)
    if row is None: return None
    ratio = float(row.get('model_ratio') or 0); comp = float(row.get('completion_ratio') or 1)
    cr = float(row.get('cache_ratio') or 1); cw = float(row.get('create_cache_ratio') or 1)
    g = float(grupo.get(group, 1))
    inp = ratio * g * 1e6 / quota
    return (buckets['input']*inp + buckets['output']*inp*comp
            + buckets['cacheRead']*inp*cr + buckets['cacheWrite']*inp*cw)/1e6

for group in ['deepseek-HK', 'deepseek-0元购', 'gemini']:
    own_cost = price('deepseek-v4.1-flash', group, b)
    tot_cost = price('deepseek-v4.1-flash', group, st)
    print(f'group={group:18s} own=${own_cost:.6f}  subtree=${tot_cost:.6f}')
