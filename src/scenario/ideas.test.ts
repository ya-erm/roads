import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { runMonths, stationAtIndustry, withoutCitizens } from '../game/testkit';
import { DEFAULT_SETTINGS, NEW_GAME_SETTINGS } from '../world/settings';
import { assess } from './feasibility';
import { IDEAS, ideaCandidates, ideaMoney } from './ideas';
import { refOf } from './analysis';
import { leftPanelHtml, leftTabs } from '../ui/scenarioUi';

/**
 * Песочница с маршрутами сырьё → ближайший завод (plants — сколько таких заводов): станции у обоих и грузовик
 * (как в советнике). Склад заводов пуст — каждый «ждёт сырьё».
 */
function sandbox(plants = 1, settings = { ...DEFAULT_SETTINGS, seed: 42 }) {
  const game = withoutCitizens(new Game(settings));
  game.money = 5_000_000;
  const list = game.industries.filter((i) => i.info.accepts.length === 1).slice(0, plants);
  for (const plant of list) {
    const near = (a: { fp: { center: { x: number; y: number } } }) => Math.hypot(a.fp.center.x - plant.fp.center.x, a.fp.center.y - plant.fp.center.y);
    const raw = game.industries.filter((i) => i.info.produces === plant.info.accepts[0]).sort((a, b) => near(a) - near(b))[0];
    const a = stationAtIndustry(game, raw, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, raw.fp.center)!;
    const line = game.createLine([a.id, b.id])!;
    game.buyVehicle(line.id, 'truck');
    plant.stock = {};
  }
  const plant = list[0];
  return { game, plant, input: plant.info.accepts[0] };
}

/** Итоги месяца для идей «сейчас»: срок первой идеи уже прошёл. */
function offerNow(game: Game) {
  game.ideas.state.next = 0;
  game.ideas.monthEnd();
  return game.ideas.offer;
}

describe('Задания без сроков («Идеи»)', () => {
  it('песочница: первая идея — не раньше чем через 4 мин; без срока, выполнимая, по сети игрока', () => {
    const { game, plant, input } = sandbox();
    expect(game.ideas.available).toBe(true);
    runMonths(game, IDEAS.first);
    expect(game.ideas.state.list).toHaveLength(0);
    runMonths(game, 1);
    const o = game.ideas.offer!;
    expect(o).toBeDefined();
    expect(o.status).toBe('offered');
    // Первый вид по кругу — завод ждёт сырьё: его и предлагаем.
    expect(o.kind).toBe('input');
    expect(o.params).toMatchObject({ kind: 'deliver', cargo: input, to: refOf(plant) });
    expect(o).not.toHaveProperty('deadline');
    expect(assess(game, o.params, IDEAS.horizon).ok).toBe(true);
    expect(o.reward.money).toBeGreaterThanOrEqual(IDEAS.money.min);
    expect(o.reward.money).toBeLessThanOrEqual(IDEAS.money.max);
    // Пока предложение не решено, новых нет — сколько бы ни прошло.
    runMonths(game, IDEAS.gap + 1);
    expect(game.ideas.state.list.filter((i) => i.status === 'offered')).toHaveLength(1);
  });

  it('взять → доставки в счёт с этой минуты → выполнено: награда «Награды и субсидии», без штрафов', () => {
    const { game, plant, input } = sandbox();
    const o = offerNow(game)!;
    // До взятия доставки не в счёт.
    game.ideas.onDelivered(input, 500, refOf(plant), 1);
    expect(game.ideas.take(o.id)).toBe(true);
    expect(o.progress).toBe(0);
    const money = game.money;
    game.ideas.onDelivered(input, o.target, refOf(plant), 1);
    game.ideas.tick(1);
    expect(o.status).toBe('done');
    expect(game.money).toBe(money + o.reward.money);
    expect(game.ledger.grants).toBe(o.reward.money);
    expect(game.ideas.state.done).toBe(1);
    // Выполненное видно минуту, потом уходит.
    runMonths(game, IDEAS.shown + 1);
    expect(game.ideas.idea(o.id)).toBeUndefined();
  });

  it('отказ и «бросить» — без последствий, тот же предмет не предлагается 30 мин; «позже» — вернётся через 10 мин', () => {
    const { game } = sandbox();
    const o = offerNow(game)!;
    const money = game.money;
    expect(game.ideas.drop(o.id)).toBe(true);
    expect(game.money).toBe(money);
    expect(game.ideas.state.skip[o.key]).toBeGreaterThan(game.time / 60 + IDEAS.skip - 0.01);
    // Следующая — уже о другом (или ничего).
    const next = offerNow(game);
    if (next) expect(next.key).not.toBe(o.key);

    const { game: g2 } = sandbox();
    const p = offerNow(g2)!;
    expect(g2.ideas.later(p.id)).toBe(true);
    expect(g2.ideas.offer).toBeUndefined();
    // Отложенное держит место: новых не предлагаем.
    offerNow(g2);
    expect(g2.ideas.state.list.filter((i) => i.status === 'offered')).toHaveLength(1);
    runMonths(g2, IDEAS.later + 1);
    expect(g2.ideas.offer?.id).toBe(p.id);
  });

  it('взятых — не больше двух; когда два в работе, новых предложений нет', () => {
    const { game } = sandbox(3);
    for (let n = 0; n < IDEAS.active; n++) {
      const o = offerNow(game)!;
      expect(game.ideas.take(o.id)).toBe(true);
    }
    expect(game.ideas.active).toHaveLength(IDEAS.active);
    expect(offerNow(game)).toBeUndefined();
  });

  it('в идущем сценарии идей нет; проигран — включаются', () => {
    const game = withoutCitizens(new Game({ ...NEW_GAME_SETTINGS, seed: 7, scenario: { difficulty: 'normal', challenge: false } }));
    expect(game.ideas.available).toBe(false);
    runMonths(game, 1);
    expect(game.ideas.state.next).toBeUndefined();
    game.scenario!.lose('проверка');
    expect(game.ideas.available).toBe(true);
    runMonths(game, 1);
    // Отсчёт до первой идеи — от конца сценария.
    expect(game.ideas.state.next).toBe(game.monthIndex + IDEAS.first);
  });

  it('выключили в настройках — предложение и взятые снимаются, вкладки нет; включили — отсчёт заново', () => {
    const { game } = sandbox();
    const o = offerNow(game)!;
    game.ideas.take(o.id);
    game.ideas.setEnabled(false);
    expect(game.ideas.available).toBe(false);
    expect(game.ideas.active).toHaveLength(0);
    expect(game.ideas.state.next).toBeUndefined();
    game.ideas.setEnabled(true);
    runMonths(game, 1);
    expect(game.ideas.state.next).toBe(game.monthIndex + IDEAS.first);
  });

  it('сохраняется с партией', () => {
    const { game } = sandbox();
    const o = offerNow(game)!;
    game.ideas.take(o.id);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.ideas.active.map((i) => i.key)).toEqual([o.key]);
    // Песочница, где идеи ещё не включались, — без поля в сохранении.
    expect(new Game({ ...DEFAULT_SETTINGS, seed: 3 }).toSave().ideas).toBeUndefined();
  });

  it('панель песочницы: вкладки нет, пока предложить нечего; есть — «События» с карточкой ☕, «Взять / Позже / ✕», подсказки data-tip', () => {
    const { game } = sandbox();
    expect(leftTabs(game)).toEqual([]);
    expect(leftPanelHtml(game, { collapsed: false, open: new Set(), confirmAdvance: false })).toBe('');
    const o = offerNow(game)!;
    expect(leftTabs(game)).toEqual(['events']);
    const html = leftPanelHtml(game, { collapsed: false, open: new Set(), confirmAdvance: false });
    expect(html).toContain('<h3>События</h3>');
    expect(html).toContain('sc-ideas');
    expect(html).toContain('☕');
    for (const act of ['idea-take', 'idea-later', 'idea-drop']) expect(html).toContain(`data-action="${act}" data-id="${o.id}"`);
    expect(html).not.toMatch(/ title="/);
    expect(html).not.toContain('⏳');
    // Взяли — полоска и «бросить»; свёрнутая — строкой.
    game.ideas.take(o.id);
    const taken = leftPanelHtml(game, { collapsed: false, open: new Set(), confirmAdvance: false });
    expect(taken).toContain('sc-bar');
    expect(taken).not.toContain('idea-take');
    expect(leftPanelHtml(game, { collapsed: true, open: new Set(), confirmAdvance: false })).toContain('sc-compact');
  });

  it('песочница со стройкой: вкладки «Стройка» и «События»; число нового предложения — на «Событиях», без мигания', () => {
    const { game } = sandbox(1, { ...DEFAULT_SETTINGS, seed: 42, construction: 'build' });
    expect(leftTabs(game)).toEqual(['build']);
    const o = offerNow(game)!;
    expect(o).toBeDefined();
    expect(leftTabs(game)).toEqual(['build', 'events']);
    const html = leftPanelHtml(game, { collapsed: false, open: new Set(), confirmAdvance: false, tab: 'events' });
    // Как в сценарии: вкладки — первой строкой, свернуть — галочкой слева от них.
    expect(html).toMatch(/^<div class="lp-head"><button class="lines-toggle lp-fold" data-action="sc-toggle" data-tip="Свернуть · песочница">/);
    expect(html).toMatch(/class="lp-tab active call" data-action="left-tab" data-id="events" data-tip="☕ Идея ждёт[^"]*"><svg[^]*?<b class="lp-count call">1<\/b>/);
    expect(html).not.toContain('data-id="ideas"');
    expect(html).toContain(`data-action="idea-take" data-id="${o.id}"`);
  });

  it('после сценария: идеи — первым разделом вкладки «События», отдельной вкладки нет', () => {
    const { game } = sandbox(1, { ...NEW_GAME_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } });
    game.scenario!.lose('проверка');
    const o = offerNow(game)!;
    expect(o).toBeDefined();
    expect(leftTabs(game)).toEqual(['scenario', 'events']);
    const view = { collapsed: false, open: new Set<string>(), confirmAdvance: false, tab: 'events' as const };
    const html = leftPanelHtml(game, view);
    expect(html).toMatch(/data-id="events" data-tip="☕ Идея ждёт/);
    const body = html.slice(html.indexOf('</nav>'));
    expect(body.indexOf('sc-ideas')).toBeGreaterThan(0);
    expect(body.indexOf('sc-ideas')).toBeLessThan(body.indexOf('<section class="sc-sec">') === -1 ? Infinity : body.indexOf('<section class="sc-sec">'));
    // Свёрнутая «События» — строкой с идеей.
    const folded = leftPanelHtml(game, { ...view, collapsed: true });
    expect(folded).toContain('sc-compact-text');
    expect(folded).toContain('lp-count call">1</span>');
  });

  it('кандидаты — только по сети игрока: без маршрутов предлагать нечего', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    for (const kind of ['input', 'export', 'town', 'link', 'supply'] as const) expect(ideaCandidates(game, kind)).toHaveLength(0);
    expect(ideaMoney(1000, 'goods')).toBe(IDEAS.money.max);
    expect(ideaMoney(1, 'grain')).toBe(IDEAS.money.min);
  });
});
