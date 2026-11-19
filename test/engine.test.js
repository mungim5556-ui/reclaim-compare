import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paperMode, compare, costScenario, mixedWaste, paramValues, quantitiesFromArea, schedule, excavators, crews, selExtra } from "../assets/js/scenario.js";
import { breakEven, simulate, tornado, triangular, variables, mulberry32 } from "../assets/js/sensitivity.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../assets/data/${f}`, import.meta.url)));
const paper = load("paper2023_case.json"), rates = load("rates.json");
const p = paramValues(rates), q = quantitiesFromArea(2400, "공동주택", rates), vars = variables(rates);

test("논문 사례 재현: 표 5·8·9와 Δ = −34,727천원", () => {
  const r = paperMode(paper);
  assert.deepEqual(r.construction, paper.expected.construction);
  assert.deepEqual(r.disposal, paper.expected.disposal);
  assert.equal(r.sheets, 2469);
  assert.equal(r.revenue, paper.expected.revenue);
  assert.equal(r.delta, paper.expected.delta);
});

test("논문 사례: 재활용 수익이 0이면 분별이 28,699천원 더 비싸다", () => {
  const c = structuredClone(paper);
  c.revenue.wood.won_per_sheet = 0; c.revenue.resin.won_per_t = 0;
  assert.equal(paperMode(c).delta, 28699);
});

test("분별 추가 품 = 논문 표 3·4의 분별 − 일반 차이", () => {
  const diff = (i) => +rates.laborItems.reduce((s, x) => s + x.selective[i] - x.crush[i], 0).toFixed(3);
  assert.deepEqual([diff(0), diff(1)], [0.09, 0.025]);
  assert.deepEqual([p.sel_extra_carpenter, p.sel_extra_laborer], [0.09, 0.025]);
  // 논문 사례 규모(2,400㎡)에서 논문의 시공비 증가 67,522천원과 같다
  const rows = costScenario({ ...q, floors: 5 }, p, "selective").rows.filter((r) => r.item.startsWith("분별 추가"));
  assert.equal(Math.round(rows.reduce((a, r) => a + r.qty, 0)), 276);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.amount, 0) / 1000 - 67522) < 1);
});

test("작업조: 계획서 규모에서 하루 6~10인, 굴착기 대수는 넉넉한 대지에서만 면적에 따라", () => {
  // 4,515㎡ 계획서는 학교 부지라 넉넉함, 나머지는 보통
  for (const [area, floors, site] of [[965.04, 4, "normal"], [4514.84, 4, "wide"], [102.3, 2, "normal"], [126.18, 2, "normal"]]) {
    const s = costScenario({ ...quantitiesFromArea(area, "비주거 RC", rates), floors, site }, p, "crush");
    const perDay = s.rows.filter((r) => r.group === "인건비").reduce((a, r) => a + r.qty, 0) / s.days;
    assert.ok(perDay >= 6 && perDay <= 10, `${area}㎡ 하루 ${perDay.toFixed(1)}인`);
    if (area === 126.18) assert.ok(Math.abs(perDay - 7.2) <= 1); // 인원표가 있는 계획서 1건 (관리자·안전요원 제외)
    assert.ok(!s.rows.some((r) => r.item.startsWith("분별 추가")));
  }
  assert.equal(excavators({ area_m2: 965.04, site: "wide" }, p), 1);
  assert.equal(excavators({ area_m2: 4514.84, site: "wide" }, p), 2);
  assert.equal(crews({ area_m2: 4514.84, site: "wide" }, p).standing, 5);
  for (const site of ["normal", "tight", "restricted", undefined]) assert.equal(excavators({ area_m2: 4514.84, site }, p), 1);
});

test("총액 = 내역 행의 합, 구조체 비용은 두 안이 같다", () => {
  const { crush, selective } = compare(q, p);
  for (const s of [crush, selective]) {
    assert.ok(Math.abs(s.rows.reduce((a, r) => a + r.amount, 0) - s.total) < 1);
    assert.ok(s.total > 0 && s.days > 0);
  }
  assert.equal(crush.equipment, selective.equipment);
  assert.ok(selective.labor > crush.labor && selective.disposal < crush.disposal && selective.days > crush.days);
});

test("혼합폐기물 처리비가 오르면 분별 쪽으로 기운다", () => {
  const base = compare(q, p).delta;
  assert.ok(compare(q, { ...p, fee_mixed_crush: p.fee_mixed_crush * 3 }).delta < base);
});

test("손익분기: 찾은 값에서 Δ ≈ 0", () => {
  const x = breakEven(q, p, "net_resin", -5e5, 5e6);
  assert.ok(x != null);
  assert.ok(Math.abs(compare(q, { ...p, net_resin: x }).delta) < 1);
  assert.equal(breakEven(q, p, "hours_per_day", 1, 24), null); // 두 안에 공통이라 부호가 바뀌지 않는다
});

test("몬테카를로: 같은 seed면 같은 결과, 분위수 순서", () => {
  const a = simulate(q, p, vars, { n: 500, seed: 7 }), b = simulate(q, p, vars, { n: 500, seed: 7 });
  assert.equal(a.pSelective, b.pSelective);
  assert.equal(a.p50, b.p50);
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.notEqual(simulate(q, p, vars, { n: 500, seed: 8 }).p50, a.p50);
});

test("삼각분포는 범위 안, 토네이도는 영향 큰 순", () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 1000; i++) { const x = triangular(rnd(), 2, 2, 5); assert.ok(x >= 2 && x <= 5); }
  const t = tornado(q, p, vars);
  assert.ok(t.length === vars.length && t[0].span >= t.at(-1).span);
});

test("철근 추정: IFC 물량이면 콘크리트 부피에서 고철 수익이 나온다", () => {
  const ifcQ = { area_m2: 100, concrete_m3: 50, rebarFromConcrete: true, t: { concrete: 120 } };
  const row = costScenario(ifcQ, p, "crush").rows.find((r) => r.item === "고철");
  assert.ok(Math.abs(row.qty - 50 * 0.1 * 0.9) < 1e-9);
});

test("공기 규칙: 해체계획서 4건의 공정표와 비교", () => {
  // [연면적, 지상 층수, 계획서 구조체 일수, 계획서 전체 작업일, 전체 허용 오차]
  const plans = [[965.04, 4, 11, 15, 0.15], [4514.84, 4, 34, 47, 0.15], [102.3, 2, 6, 10, 0.15], [126.18, 2, 13, 15, 0.45]];
  for (const [area, floors, structure, total, tol] of plans) {
    const s = schedule({ area_m2: area, floors }, p, "crush");
    assert.ok(Math.abs(s.total - total) / total <= tol, `${area}㎡: ${s.total.toFixed(1)}일 vs 계획서 ${total}일`);
    if (tol < 0.2) assert.ok(Math.abs(s.structure - structure) <= 2, `${area}㎡ 구조체 ${s.structure.toFixed(1)} vs ${structure}`);
    assert.equal(s.selective, 0);
  }
});

test("공기 규칙: 분별안은 추가 인원만큼만 늘어난다", () => {
  const q4 = { ...q, floors: 5 }, c = schedule(q4, p, "crush"), s = schedule(q4, p, "selective");
  const extra = 2400 * (0.09 + 0.025) / p.crew_size;
  assert.ok(Math.abs(s.total - c.total - extra) < 1e-9 && Math.abs(extra - 13.8) < 0.01);
  assert.ok(Math.abs(compare(q4, p).crush.days - c.total) < 1e-9);
});

test("분리 목재·수지는 순단가 하나: +면 매각수익, −면 처리비 (둘이 함께 들어가지 않는다)", () => {
  const qq = { ...q, floors: 5 };
  for (const [net, group] of [[-230000, "처리비"], [150000, "매각수익"]]) {
    const s = costScenario(qq, { ...p, net_resin: net }, "selective");
    const rows = s.rows.filter((r) => r.item.endsWith("폐합성수지"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].group, group);
    assert.ok(Math.abs(Math.abs(rows[0].amount) - Math.abs(net) * qq.t.resin * p.rec_sel) < 1);
  }
  assert.ok(!costScenario(qq, p, "crush").rows.some((r) => r.item.endsWith("폐합성수지")));
});

test("분별 후 혼합폐기물 단가는 가연물 5% 조건과 주성상으로 정한다", () => {
  const t = { concrete: 0, metal: 0, copper: 0, aluminum: 0, glass: 0, board: 0, mixed: 100, wood: 10, resin: 10 };
  const m = (sep, extra = {}) => mixedWaste({ ...t, ...extra }, sep, p, "selective");
  // 분리율 0.8: 남은 가연물 4t / 104t = 3.8% → 낮은 단가
  assert.equal(m(0.8).fee, p.fee_mixed_selective);
  assert.ok(Math.abs(m(0.8).share - 4 / 104) < 1e-9);
  // 분리율 0.5: 10t / 110t = 9.1% → 한도 초과, 압쇄와 같은 단가
  assert.equal(m(0.5).fee, p.fee_mixed_crush);
  assert.equal(m(0.5).rule, "가연물 한도 초과");
  // 보드가 주성상이면 보드 단가, 유리가 주성상이면 유리·타일 단가
  assert.equal(m(0.8, { board: 200 }).fee, p.fee_board_mixed);
  assert.equal(m(0.8, { glass: 200 }).fee, p.fee_mixed_crush);
  // 압쇄는 늘 압쇄 단가
  assert.equal(mixedWaste(t, 0, p, "crush").fee, p.fee_mixed_crush);
});

test("분리율이 낮아 가연물 한도를 넘으면 분별의 처리비 이득이 사라진다", () => {
  const qq = { ...q, floors: 5 };
  const hi = costScenario(qq, { ...p, rec_sel: 1 }, "selective"), lo = costScenario(qq, { ...p, rec_sel: 0.5 }, "selective");
  assert.equal(hi.mixed.fee, p.fee_mixed_selective);
  assert.equal(lo.mixed.fee, p.fee_mixed_crush);
});

test("대지 협소·진입 제한: 소형 장비로 장비 시간이 늘고 크레인이 붙으며 구조체 공기가 길어진다", () => {
  const base = { ...q, floors: 5 };
  for (const site of ["tight", "restricted"]) {
    const n = costScenario({ ...base, site: "normal" }, p, "crush"), t = costScenario({ ...base, site }, p, "crush");
    const h = (s) => s.rows.find((r) => r.unit === "h").qty;
    assert.ok(Math.abs(h(t) / h(n) - p.crush_m3_per_day / p.crush_m3_per_day_small) < 1e-9);
    const crane = t.rows.find((r) => r.item.startsWith("이동식 크레인"));
    assert.ok(crane && Math.abs(crane.qty - t.schedule.structure) < 1e-9);
    assert.ok(!n.rows.some((r) => r.item.startsWith("이동식 크레인")));
    assert.ok(t.schedule.structure > n.schedule.structure && t.equipment > n.equipment);
  }
  // 두 안에 똑같이 들어가므로 대지 조건만으로는 Δ가 거의 변하지 않는다 (간접비·상시 인원 일수만 같이 늘어난다)
  assert.equal(compare({ ...base, site: "tight" }, p).deltaDays, compare({ ...base, site: "normal" }, p).deltaDays);
});

test("분별 추가 품 작업량 방식: 보드·타일·창틀 면적 ÷ 작업량, 공기도 같은 인원으로 늘어난다", () => {
  const qq = { ...q, floors: 5, labor: "quantity" }, A = qq.area_m2;
  const x = selExtra(qq, p);
  const expected = A * p.int_board_ratio / p.int_board_m2_per_day + A * p.int_tile_ratio / p.int_tile_m2_per_day + A * p.window_ratio * p.window_frame_pd_per_m2;
  assert.equal(x.method, "quantity");
  assert.ok(Math.abs(x.persons - expected) < 1e-9);
  const s = costScenario(qq, p, "selective");
  const rows = s.rows.filter((r) => r.item.startsWith("분별 추가"));
  assert.equal(rows.length, 3);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.qty, 0) - expected) < 1e-9);
  assert.ok(Math.abs(s.schedule.selective - expected / p.crew_size) < 1e-9);
  // 기본(논문 방식)은 그대로
  assert.equal(selExtra({ ...q }, p).method, "paper");
  assert.ok(!costScenario(qq, p, "crush").rows.some((r) => r.item.startsWith("분별 추가")));
});
