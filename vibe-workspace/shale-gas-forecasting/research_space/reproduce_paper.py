import csv, json, statistics
random_seed = 0  # 固定种子,可复现
FEATURES = ["lateral_length_m","proppant_tons","stages"]
TARGET = 'first_year_production'
rows = list(csv.DictReader(open('Data/shale_wells.csv')))
X = [[float(r[f]) for f in FEATURES] for r in rows]
y = [float(r[TARGET]) for r in rows]
means = [statistics.mean(c) for c in zip(*X)]; sds = [statistics.pstdev(c) for c in zip(*X)]
A = [[1.0] + [(v - m) / s for v, m, s in zip(row, means, sds)] for row in X]
n = len(A[0])
M = [[sum(A[k][i] * A[k][j] for k in range(len(A))) for j in range(n)] + [sum(A[k][i] * y[k] for k in range(len(A)))] for i in range(n)]
for i in range(n):
    M[i] = [v / M[i][i] for v in M[i]]
    for r in range(n):
        if r != i:
            f = M[r][i]; M[r] = [a - f * b for a, b in zip(M[r], M[i])]
beta = [M[i][n] for i in range(n)]
pred = [sum(b * a for b, a in zip(beta, row)) for row in A]
ss_res = sum((yi - pi) ** 2 for yi, pi in zip(y, pred)); ss_tot = sum((yi - statistics.mean(y)) ** 2 for yi in y)
r2 = 1 - ss_res / ss_tot
imp = {f: abs(b) for f, b in zip(FEATURES, beta[1:])}; tot = sum(imp.values()); imp = {k: round(v / tot, 3) for k, v in imp.items()}
results = {'model': 'OLS(standardized)', 'n': len(rows), 'r2': round(r2, 4), 'importance': imp,
           'importance_rank': sorted(imp, key=imp.get, reverse=True)}
json.dump(results, open('research_space/detailed_results.json', 'w'), indent=2, ensure_ascii=False)
bars = ''.join(f'<rect x="20" y="{20 + i * 40}" width="{int(v * 300)}" height="26" fill="#5B7FA6"/><text x="{28 + int(v * 300)}" y="{38 + i * 40}" font-size="13">{k} {v}</text>' for i, (k, v) in enumerate(sorted(imp.items(), key=lambda kv: -kv[1])))
open('research_space/fig_feature_importance.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" width="420" height="140" font-family="sans-serif">{bars}</svg>')
print(json.dumps(results, ensure_ascii=False))
