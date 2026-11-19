// 일괄 압쇄 vs 전면 분별해체 비용 엔진. DOM을 쓰지 않는 순수 함수만 둔다.
// 물량 q = { area_m2, floors(지상 층수), concrete_m3, rebarFromConcrete, t: { concrete, metal, wood, resin, glass, board, mixed, copper, aluminum } }
// 단가 p = { 키: 숫자 } (rates.json의 params에서 value만 뽑은 것)

export const STREAMS = ["concrete", "metal", "wood", "resin", "glass", "board", "mixed", "copper", "aluminum"];
export const STREAM_LABEL = {
  concrete: "폐콘크리트·조적", metal: "철근·강재", wood: "폐목재", resin: "폐합성수지", glass: "폐유리",
  board: "폐보드", mixed: "혼합·기타", copper: "구리", aluminum: "알루미늄",
};
// 분별해체에서 따로 떼어 내는 성상 (나머지는 구조체와 함께 압쇄)
export const SEPARATED = new Set(["wood", "resin", "glass", "board", "copper", "aluminum"]);

export const paramValues = (rates) => Object.fromEntries(Object.entries(rates.params).map(([k, v]) => [k, v.value]));

const tons = (q) => Object.fromEntries(STREAMS.map((s) => [s, Number(q.t?.[s]) || 0]));

export function costScenario(q, p, mode) {
  const sel = mode === "selective";
  const t = tons(q);
  // IFC 모델에는 철근이 없으므로 콘크리트 부피에서 추정한다
  const metal = t.metal + (q.rebarFromConcrete ? (q.concrete_m3 * p.rebar_kg_per_m3) / 1000 : 0);
  const rows = [];
  const add = (group, item, qty, unit, price, sign = 1) => {
    const amount = sign * qty * price;
    rows.push({ group, item, qty, unit, price, amount });
    return amount;
  };

  // 1. 인건비 — 공종별 일수 × 작업조 × 노임 (두 안 공통). 일수는 schedule()의 공기 규칙을 쓴다.
  const sched = schedule(q, p, mode), days = sched.total, crew = crews(q, p);
  let labor = add("인건비", "상시 인원 (신호수·유도자·살수공)", crew.standing * days, "인", p.wage_laborer)
    + add("인건비", "가설 설치 비계공", crew.setup * sched.setup, "인", p.wage_carpenter)
    + add("인건비", "내부 철거 인부", crew.interior * sched.interior, "인", p.wage_laborer)
    + add("인건비", "구조체 해체 보조 인부", crew.structure * sched.structure, "인", p.wage_laborer)
    + add("인건비", "마무리 인부", crew.finish * sched.finish, "인", p.wage_laborer);
  // 분별해체로 늘어나는 인원: 연면적 × 논문 표 3·4의 차이 품 (창호 분리, 선별·반출 등)
  if (sel) labor += add("인건비", "분별 추가 목공", q.area_m2 * p.sel_extra_carpenter, "인", p.wage_carpenter)
    + add("인건비", "분별 추가 보통인부", q.area_m2 * p.sel_extra_laborer, "인", p.wage_laborer);

  // 2. 구조체 해체 장비 (두 안에 공통) — 콘크리트 부피 ÷ 생산성으로 가동 시간을 구한다
  const structDays = q.concrete_m3 / p.crush_m3_per_day;
  const equipment = add("장비비", "굴착기+압쇄기", structDays * p.hours_per_day, "h", p.excavator_per_h);

  // 3. 폐기물 처리비 — 압쇄는 떼지 않은 내장재가 모두 혼합폐기물이 된다
  const sep = sel ? p.rec_sel : 0;
  const wood = t.wood * sep, resin = t.resin * sep;
  const mix = mixedWaste(t, sep, p, mode);
  let disposal = add("처리비", STREAM_LABEL.concrete, t.concrete, "t", sel ? p.fee_concrete_selective : p.fee_concrete)
    + add("처리비", "혼합건설폐기물", mix.tons, "t", mix.fee);

  // 4. 매각 수익
  const nf = sel ? p.rec_nonferrous_sel : p.rec_nonferrous_crush;
  let revenue = -add("매각수익", "고철", metal * (sel ? p.rec_scrap_sel : p.rec_scrap_crush), "t", p.price_scrap, -1)
    - add("매각수익", "구리", t.copper * nf, "t", p.price_copper, -1)
    - add("매각수익", "알루미늄", t.aluminum * nf, "t", p.price_aluminum, -1);

  // 따로 모은 폐목재·폐합성수지는 순단가 하나로 계산한다: +면 팔아서 받고, −면 돈을 내고 처리한다
  for (const [name, qty, net] of [["폐목재", wood, p.net_wood], ["폐합성수지", resin, p.net_resin]]) {
    if (!sel) continue;
    if (net >= 0) revenue -= add("매각수익", name, qty, "t", net, -1);
    else disposal += add("처리비", `분리 ${name}`, qty, "t", -net);
  }

  // 5. 간접비
  const indirect = add("간접비", "현장 간접비", days, "일", p.indirect_per_day);

  return { mode, labor, equipment, disposal, revenue, indirect, days, schedule: sched, crews: crew, mixed: mix, total: labor + equipment + disposal + indirect - revenue, rows: rows.filter((r) => r.qty > 0) };
}

// 혼합건설폐기물의 양과 처리단가 (한국건설자원협회 2026 성상별 중간처리단가의 적용 조건).
//   분별: 남은 가연물(목재·수지) 비율이 한도(5%) 이하이고 주성상이 건설폐재류(mixed)이면 72,721원/t,
//         주성상이 보드면 192,887원/t, 그 밖에는(유리·타일 중심이거나 가연물이 한도를 넘으면) 압쇄와 같은 188,715원/t.
//   압쇄: 지금처럼 188,715원/t (압쇄 쪽 조건 검사는 아직 하지 않는다).
// mixed 성상 자체에는 가연물이 없다고 본다.
export function mixedWaste(t, sep, p, mode) {
  const combustible = (t.wood + t.resin) * (1 - sep);
  const tons = t.mixed + t.glass + t.board + combustible;
  const share = tons > 0 ? combustible / tons : 0;
  const main = [["mixed", t.mixed], ["glass", t.glass], ["board", t.board]].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  if (mode !== "selective") return { tons, share, main, fee: p.fee_mixed_crush, rule: "압쇄" };
  const ok = share <= p.mixed_combustible_limit;
  if (ok && main === "mixed") return { tons, share, main, ok, fee: p.fee_mixed_selective, rule: "건설폐재류+가연물" };
  if (main === "board") return { tons, share, main, ok, fee: p.fee_board_mixed, rule: "보드 중심" };
  return { tons, share, main, ok, fee: p.fee_mixed_crush, rule: ok ? "유리·타일 중심" : "가연물 한도 초과" };
}

// 공기(작업일). 압쇄안은 해체계획서 4건의 예정공정표에서 뽑은 규칙:
//   가설 + 내부 철거 + 구조체 해체 + 마무리 (폐기물 반출은 구조체 해체와 겹쳐서 공기를 늘리지 않는다)
// 분별안은 계획서 자료가 없어서, 압쇄안 공기에 "분별로 늘어나는 인원 ÷ 작업조"를 더한다.
export function schedule(q, p, mode) {
  const k = q.area_m2 / 1000, floors = q.floors || 1;
  const setup = p.sched_setup_base + p.sched_setup_per_1000m2 * k;
  const interior = Math.max(p.sched_interior_min, p.sched_interior_per_1000m2 * k);
  const structure = p.sched_struct_base + p.sched_struct_per_floor * floors + q.area_m2 / p.sched_struct_m2_per_day;
  const finish = p.sched_finish_base + p.sched_finish_per_1000m2 * k;
  const selective = mode === "selective" ? (q.area_m2 * (p.sel_extra_carpenter + p.sel_extra_laborer)) / p.crew_size : 0;
  return { setup, interior, structure, finish, selective, total: setup + interior + structure + finish + selective };
}

// 굴착기 대수: 큰 건물일수록 장비를 더 넣는다 (계획서: 965㎡ 1대, 4,515㎡ 2대가 주 장비)
export const excavators = (q, p) => Math.max(1, Math.ceil(q.area_m2 / p.area_per_excavator));

// 공종별 하루 작업조 인원. 살수공과 구조체 보조 인부는 굴착기 대수에 비례한다.
export function crews(q, p) {
  const n = excavators(q, p);
  return { excavators: n, standing: p.crew_standing + n * p.crew_per_excavator, setup: p.crew_setup, interior: p.crew_interior, structure: p.crew_structure * n, finish: p.crew_finish };
}

export function compare(q, p) {
  const crush = costScenario(q, p, "crush"), selective = costScenario(q, p, "selective");
  return { crush, selective, delta: selective.total - crush.total, deltaDays: selective.days - crush.days };
}

// 면적 × 표준품셈 원단위로 물량을 추정 (IFC가 없을 때, 또는 모델 검산용)
export function quantitiesFromArea(area_m2, usage, rates) {
  const u = rates.wasteUnits[usage];
  const t = Object.fromEntries(STREAMS.map((k) => [k, (u[k] || 0) * area_m2]));
  return { area_m2, floors: 1, concrete_m3: t.concrete / rates.density.concrete, rebarFromConcrete: false, t, basis: "원단위" };
}

// 논문(박지선 외 2023) 계산을 그대로 따라 한다. 단위: 천원. 반올림 위치도 논문과 같다.
export function paperMode(c) {
  const A = c.area_m2, k = (won) => Math.round(won / 1000);
  const construction = ["general", "selective"].map((m) =>
    k(Math.round(A * c.productivity_per_m2[m].carpenter) * c.wage.carpenter) + k(Math.round(A * c.productivity_per_m2[m].laborer) * c.wage.laborer));
  const w = c.waste_t_per_m2, d = c.disposal_won_per_t;
  const common = k(A * w.concrete * d.concrete) + k(A * w.wood * d.wood) + k(A * w.resin * d.resin);
  const disposal = [common + k(A * w.mixed * d.mixed_general), common + k(A * w.mixed * d.mixed_selective)];
  const [sx, sy, sz] = c.revenue.wood.sheet_m;
  const sheets = Math.floor(Math.round(A * w.wood) / (sx * sy * sz * c.revenue.wood.density));
  const revenue = k(sheets * c.revenue.wood.won_per_sheet) + k(Math.round(A * w.resin) * c.revenue.resin.won_per_t);
  const delta = construction[1] - construction[0] - (disposal[0] - disposal[1]) - revenue;
  return { construction, disposal, revenue, sheets, delta };
}
