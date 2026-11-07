import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { clockText, durationText } from '../core/timeText';
import { Game } from '../game/game';
import { freightRoute, withoutCitizens } from '../game/testkit';
import { DEFAULT_SETTINGS } from '../world/settings';
import { briefHtml, isFolded, leftPanelHtml, leftTab, leftTabs, offerBannerHtml, offersSectionHtml, toggleFold, type PanelView } from './scenarioUi';

/** Партия-сценарий со стартовым предложением контракта и ещё одним — посрочнее. */
function scenarioWithOffers() {
  const game = new Game({ ...DEFAULT_SETTINGS, seed: 7, scenario: { difficulty: 'easy', challenge: false } });
  const sc = game.scenario!;
  const town = game.towns.find((t) => t.demands.length)!;
  const extra = sc.addObjective(
    { kind: 'deliver', cargo: town.demands[0], amount: 60, to: { type: 'town', id: town.id } },
    { role: 'contract', phase: null, months: 5, offer: true, why: 'Город ищет перевозчика.', reward: { money: 45000 }, related: [{ type: 'town', id: town.id }] },
  );
  extra.offerUntil = sc.month + 1;
  return { game, sc, extra };
}

const view = (): PanelView => ({ collapsed: false, open: new Set(), confirmAdvance: false });

describe('Предложения контрактов в панели сценария', () => {
  it('все предложения с кнопками, самое срочное — первым; подробности — по раскрытию', () => {
    const { game, sc, extra } = scenarioWithOffers();
    expect(sc.offers.length).toBeGreaterThanOrEqual(2);
    const html = offersSectionHtml(game, new Set());
    for (const o of sc.offers) {
      expect(html).toContain(`data-action="sc-accept" data-id="${o.id}"`);
      expect(html).toContain(`data-action="sc-decline" data-id="${o.id}"`);
      expect(html).toContain(`data-offer="${o.id}"`);
    }
    expect(html.indexOf(`data-id="${extra.id}"`)).toBeLessThan(html.indexOf(`data-id="${sc.offers.find((o) => o !== extra)!.id}"`));
    expect(html).not.toContain('<p class="sc-cause">Город ищет перевозчика.</p>');
    expect(offersSectionHtml(game, new Set([extra.id]))).toContain('<p class="sc-cause">Город ищет перевозчика.</p>');
  });

  it('первым разделом вкладки «События», не на «Сценарии»; в свёрнутой — на любой вкладке; решать нечего — раздела нет', () => {
    const { game, sc } = scenarioWithOffers();
    const events = leftPanelHtml(game, { ...view(), tab: 'events' });
    expect(events).toContain('sc-accept');
    expect(events.indexOf('sc-offers')).toBeLessThan(events.indexOf('sc-card event') === -1 ? events.length : events.indexOf('sc-card event'));
    expect(leftPanelHtml(game, view())).not.toContain('sc-accept');
    expect(leftPanelHtml(game, view())).toContain('sc-steps');
    expect(leftPanelHtml(game, { ...view(), collapsed: true })).toContain('sc-accept');
    expect(leftPanelHtml(game, { ...view(), collapsed: true, tab: 'events' })).toContain('sc-accept');
    for (const o of [...sc.offers]) sc.decline(o.id);
    expect(offersSectionHtml(game, new Set())).toBe('');
    expect(leftPanelHtml(game, { ...view(), tab: 'events' })).not.toContain('sc-offers');
  });
});

describe('Вкладки левой панели', () => {
  const tabsOf = (html: string) => [...html.matchAll(/data-action="left-tab" data-id="(\w+)"/g)].map((m) => m[1]);
  const tabHtml = (html: string, id: string) => html.slice(html.indexOf(`data-id="${id}"`), html.indexOf('</button>', html.indexOf(`data-id="${id}"`)));

  it('сценарий без стройки: «Сценарий» и «События»; у «Событий» — число предложений и подсветка; выбранная — active', () => {
    const { game, sc } = scenarioWithOffers();
    expect(leftTabs(game)).toEqual(['scenario', 'events']);
    const html = leftPanelHtml(game, view());
    expect(tabsOf(html)).toEqual(['scenario', 'events']);
    expect(html).toContain('class="lp-tab active " data-action="left-tab" data-id="scenario"');
    const ev = tabHtml(html, 'events');
    expect(ev).toContain(`<b class="lp-count call">${sc.offers.length}</b>`);
    expect(ev).toContain('data-tip="Контракты ждут решения');
    expect(html).toMatch(/class="lp-tab  call" data-action="left-tab" data-id="events"/);
    // Меньше минуты на решение — красным и мигает.
    game.time = (sc.month + 0.5) * MONTH_LENGTH;
    expect(leftPanelHtml(game, view())).toMatch(/class="lp-tab  call urgent pulse" data-action="left-tab" data-id="events"/);
    expect(leftPanelHtml(game, view())).toContain('<b class="lp-count call urgent">');
    game.time = 0;
    // Вкладки стройки нет — и выбор «Стройки» откатывается к первой.
    expect(leftTab(game, 'build')).toBe('scenario');
    expect(leftPanelHtml(game, { ...view(), tab: 'build' })).toBe(html);
    // Решать нечего — без числа и подсветки.
    for (const o of [...sc.offers]) sc.decline(o.id);
    const calm = tabHtml(leftPanelHtml(game, view()), 'events');
    expect(calm).not.toContain('lp-count');
    expect(leftPanelHtml(game, view())).not.toMatch(/lp-tab [^"]*call/);
  });

  it('«Со строительством» — третья вкладка «Стройка»; первую базу ещё не ставили — вкладка подсвечена, кнопка зовёт', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 7, scenario: { difficulty: 'easy', challenge: false }, construction: 'build' });
    expect(leftTabs(game)).toEqual(['scenario', 'events', 'build']);
    const html = leftPanelHtml(game, { ...view(), tab: 'build' });
    expect(tabsOf(html)).toEqual(['scenario', 'events', 'build']);
    expect(html).toMatch(/class="lp-tab active call pulse" data-action="left-tab" data-id="build" data-tip="Стройка: поставьте первую базу — бесплатно/);
    expect(html).toContain('build-add  first');
    expect(html).toContain('＋ База · бесплатно');
    // На «Сценарии» вкладка «Стройка» тоже подсвечена; в свёрнутой панели — строка стройки с «＋ База».
    expect(leftPanelHtml(game, view())).toMatch(/class="lp-tab  call pulse" data-action="left-tab" data-id="build"/);
    const folded = leftPanelHtml(game, { ...view(), tab: 'build', collapsed: true });
    expect(folded).toContain('build-compact');
    expect(folded).toContain('data-action="base-place"');
    expect(folded).not.toContain('sc-steps');
  });

  it('свёрнутая «События» — последнее событие строкой, если решать нечего', () => {
    const { game, sc } = scenarioWithOffers();
    for (const o of [...sc.offers]) sc.decline(o.id);
    const folded = leftPanelHtml(game, { ...view(), tab: 'events', collapsed: true });
    expect(tabsOf(folded)).toEqual(['scenario', 'events']);
    expect(folded).toContain('sc-compact');
    expect(folded).not.toContain('sc-steps');
  });
});

describe('Плашка предложения вверху', () => {
  it('уведомляет о самом срочном предложении без кнопок решения, остальные — счётчиком, клик ведёт к предложению в панели сценария', () => {
    const { game, sc, extra } = scenarioWithOffers();
    const html = offerBannerHtml(game);
    // Принять или отказаться — только в панели сценария.
    expect(html).not.toContain('sc-accept');
    expect(html).not.toContain('sc-decline');
    expect(html).toContain(`data-action="sc-offer-show" data-id="${extra.id}"`);
    // Остальные предложения — только счётчиком.
    for (const o of sc.offers.filter((x) => x !== extra)) expect(html).not.toContain(`data-id="${o.id}"`);
    expect(html).toContain(`>+${sc.offers.length - 1}</button>`);
  });

  it('значки города и предприятия — кнопки перехода к ним на карте, каждое место один раз', () => {
    const { game, extra } = scenarioWithOffers();
    const town = extra.related[0];
    const ind = game.industries[0];
    extra.related = [town, { type: 'industry', id: ind.id }, town];
    const html = offerBannerHtml(game);
    const townBtn = `data-action="focus" data-type="town" data-id="${town.id}"`;
    expect(html).toContain(townBtn);
    expect(html.split(townBtn).length - 1).toBe(1);
    expect(html).toContain(`data-action="focus" data-type="industry" data-id="${ind.id}" title="${ind.name} — показать на карте"`);
    // Без мест — просто значок задания, без переходов.
    extra.related = [];
    expect(offerBannerHtml(game)).not.toContain('data-action="focus"');
    expect(offerBannerHtml(game)).toContain('ob-obj');
  });

  it('одно предложение — без счётчика; решать нечего — плашки нет', () => {
    const { game, sc, extra } = scenarioWithOffers();
    for (const o of sc.offers.filter((x) => x !== extra)) sc.decline(o.id);
    expect(offerBannerHtml(game)).not.toContain('ob-more');
    sc.accept(extra.id);
    expect(offerBannerHtml(game)).toBe('');
  });
});

describe('Свёрнутые цели в панели сценария', () => {
  it('свёрнутая цель — компактной строкой без награды и мест, клик по ней разворачивает', () => {
    const { game, sc } = scenarioWithOffers();
    const goals = sc.state.objectives.filter((o) => o.phase === 0 && o.status === 'active');
    const [a, b] = goals;
    toggleFold(a);
    const html = leftPanelHtml(game, view());
    expect(html).toContain(`class="sc-obj ${a.role} active  folded" data-action="sc-fold" data-id="${a.id}"`);
    // Развёрнутая — с кнопкой «Свернуть» и наградой.
    expect(html).toContain(`<button class="sc-fold" data-action="sc-fold" data-id="${b.id}"`);
    expect(html).not.toContain(`<button class="sc-fold" data-action="sc-fold" data-id="${a.id}"`);
    const folded = html.slice(html.indexOf(`data-id="${a.id}"`), html.indexOf(`data-id="${b.id}"`));
    expect(folded).not.toContain('sc-reward');
    expect(folded).not.toContain('sc-chips');
    expect(folded).toContain('sc-bar');
    toggleFold(a);
    expect(isFolded(a)).toBe(false);
    expect(a.folded).toBeUndefined();
  });

  it('значки свёрнутых и развёрнутых целей одного размера', () => {
    const { game, sc } = scenarioWithOffers();
    const goals = sc.state.objectives.filter((o) => o.phase === 0 && o.status === 'active');
    toggleFold(goals[0]);
    const html = leftPanelHtml(game, view());
    const sizes = [...html.matchAll(/<span class="sc-obj-ic"><svg[^>]*?\swidth="(\d+)"/g)].map((m) => m[1]);
    expect(sizes.length).toBe(goals.length);
    expect(new Set(sizes)).toEqual(new Set(['26']));
  });

  it('свёрнутые цели запоминаются в сохранении партии', () => {
    const { game, sc } = scenarioWithOffers();
    const [a, b] = sc.state.objectives.filter((o) => o.phase === 0 && o.status === 'active');
    toggleFold(a);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(isFolded(loaded.scenario!.objective(a.id)!)).toBe(true);
    expect(isFolded(loaded.scenario!.objective(b.id)!)).toBe(false);
    expect(leftPanelHtml(loaded, view())).toContain(`folded" data-action="sc-fold" data-id="${a.id}"`);
  });

  it('выполненная цель сворачивается сама, а развёрнутая после выполнения — остаётся развёрнутой', () => {
    const { sc } = scenarioWithOffers();
    const [a, b] = sc.state.objectives.filter((o) => o.phase === 0 && o.status === 'active');
    // a — развёрнута и свёрнута обратно до выполнения, b — свёрнута заранее: обе свернутся при выполнении.
    toggleFold(a);
    toggleFold(a);
    toggleFold(b);
    a.status = 'done';
    b.status = 'done';
    expect(isFolded(a)).toBe(true);
    expect(isFolded(b)).toBe(true);
    toggleFold(a);
    expect(isFolded(a)).toBe(false);
    expect(a.folded).toBe(false);
  });
});

describe('Шкала месячной цели в панели сценария', () => {
  it('полоска и подпись — сколько перевезено в этом месяце, месяцы подряд — точками; в свёрнутой — то же кратко', () => {
    const { game, sc } = scenarioWithOffers();
    const o = sc.addObjective({ kind: 'throughput', amount: 470, costRatio: 0.8, months: 3 }, { role: 'goal', phase: 0, months: 6, why: 'Проверка шкалы.', reward: { money: 1000 } });
    o.streak = o.progress = 1;
    sc.state.stats.units = 235;
    const html = leftPanelHtml(game, view());
    const row = html.slice(html.indexOf(`data-id="${o.id}"`));
    expect(row).toContain('style="width:50.0%"');
    expect(row).toContain('235 / 470 ед.</b><span class="sc-month">в этом месяце</span>');
    expect(row).not.toContain('1 / 3 мес.');
    expect(row).toMatch(/<span class="sc-streak"[^>]*><i class="on"><\/i><i class=""><\/i><i class=""><\/i><\/span>/);
    toggleFold(o);
    const folded = leftPanelHtml(game, view());
    const frow = folded.slice(folded.indexOf(`data-id="${o.id}"`));
    expect(frow).toContain('235 / 470 ед.</b><span class="sc-streak"');
    expect(frow.slice(0, frow.indexOf('</div></div>'))).not.toContain('в этом месяце');
  });
});

describe('Прогноз к сроку на шкале задания', () => {
  /** Сценарий с грузовым маршрутом ферма → пищекомбинат и контракт на amount ед. груза пищекомбинату за months мин. */
  function contract(amount: number, months = 8) {
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5, scenario: { difficulty: 'easy', challenge: false } }));
    const sc = game.scenario!;
    const route = freightRoute(game);
    const o = sc.addObjective(
      { kind: 'deliver', cargo: route.from.info.produces, amount, to: { type: 'industry', id: route.to.id } },
      { role: 'contract', phase: null, months, why: 'Проверка прогноза.', reward: { money: 1000 } },
    );
    const row = () => {
      const html = leftPanelHtml(game, view());
      return html.slice(html.indexOf(`data-id="${o.id}"`));
    };
    /** Купить грузовики и перейти к следующей секунде игры — прогноз пересчитывается раз в секунду. */
    const buy = (n: number) => {
      for (let i = 0; i < n; i++) game.buyVehicle(route.line.id, 'truck');
      game.time += 1;
    };
    return { game, o, row, buy };
  }

  it('линий нет — полупрозрачной части нет, подсказка: возить пока некому', () => {
    const { row } = contract(500);
    const html = row();
    expect(html).not.toContain('class="sc-fc"');
    expect(html).toContain('data-tip="Прогноз к сроку: ~0 — возить пока некому"');
  });

  it('купили грузовик — прогноз сразу, до первой доставки: полупрозрачная часть и когда первая доставка', () => {
    const { o, row, buy } = contract(5000);
    buy(1);
    const html = row();
    expect(o.progress).toBe(0);
    expect(html).toContain('style="width:0.0%"></div><i class="sc-fc"');
    expect(html).toMatch(/<div class="sc-track" data-tip="Прогноз к сроку: ~[\d\s]+ · первая доставка через ~\d+ (сек|мин)">/);
    expect(html.slice(0, html.indexOf('sc-meta'))).not.toContain('sc-fc-ok');
    // Ещё грузовики — прогноз больше; в свёрнутом виде — та же шкала.
    const width = (h: string) => Number(/class="sc-fc" style="width:([\d.]+)%"/.exec(h)![1]);
    buy(2);
    expect(width(row())).toBeGreaterThan(width(html));
    toggleFold(o);
    expect(row()).toContain('<i class="sc-fc"');
  });

  it('прогноз выше цели — до конца шкалы и приглушённая ✓ «успеваем»; срок раньше первой доставки — «не успеют»', () => {
    const { row, buy } = contract(30);
    buy(3);
    const html = row();
    expect(html).toContain('<i class="sc-fc" style="width:100.0%"></i>');
    expect(html).toMatch(/data-tip="Прогноз к сроку: ~[\d\s]+ · первая доставка через ~\d+ (сек|мин) — успеваем"/);
    expect(html).toContain('<span class="sc-fc-ok">✓</span>');
    // Срок через полсекунды — первая машина не доедет.
    const late = contract(30, 1);
    late.buy(1);
    late.game.time = MONTH_LENGTH - 0.5;
    expect(late.row()).toContain('data-tip="Прогноз к сроку: ~0 — машины не успеют доехать до срока"');
  });
});

describe('Сроки — минутами и секундами, а не месяцами', () => {
  it('до срока задания — спокойно, «4 мин» (вверх), до конца предложения — таймер «м:сс», срок контракта — «N мин»', () => {
    const { game, sc, extra } = scenarioWithOffers();
    // Середина месяца: до начала следующего — ровно 30 с, до конца предложения — столько же.
    game.time = (sc.month + 0.5) * MONTH_LENGTH;
    const goal = sc.current.find((o) => o.deadline !== null)!;
    goal.deadline = sc.month + 4;
    const panel = leftPanelHtml(game, view());
    // 3,5 минуты — «4 мин»: секунды у сроков заданий не бегут.
    expect(panel).toContain('⏳ 4 мин');
    expect(panel).not.toContain(`⏳ ${clockText(3.5 * MONTH_LENGTH)}`);
    expect(panel).not.toMatch(/\d мес\./);
    // Последняя минута — секундами.
    goal.deadline = sc.month + 1;
    expect(leftPanelHtml(game, view())).toContain('⏳ 30 сек');
    const offers = offersSectionHtml(game, new Set());
    expect(offers).toContain(`⌛ ${clockText(0.5 * MONTH_LENGTH)}`);
    expect(offers).toContain(`⏳ ${durationText(extra.months! * MONTH_LENGTH)}`);
    // Меньше минуты на решение — предложение подсвечено.
    expect(offers).toContain(`of-card urgent" data-offer="${extra.id}"`);
    expect(offerBannerHtml(game)).toContain('offer-banner-in urgent');
    expect(offers).not.toMatch(/\d мес\./);
  });

  it('брифинг: ожидаемая продолжительность и сроки целей — в минутах, «10 мин», а не «10:00»', () => {
    const { game, sc } = scenarioWithOffers();
    const html = briefHtml(game);
    expect(html).toContain(`<b>≈ ${Math.round((sc.state.brief.months * MONTH_LENGTH) / 60)}</b><small>мин</small>`);
    const goals = html.slice(html.indexOf('class="brief-goals"'), html.indexOf('Стартовый контракт'));
    const goal = sc.current.find((o) => o.deadline !== null)!;
    expect(goals).toContain(`⏳ ${Math.ceil(sc.secondsLeft(goal)! / 60)} мин`);
    const fast = sc.current.find((o) => o.fast !== undefined);
    if (fast) expect(goals).toContain(`⚡ ${Math.ceil(sc.fastLeft(fast)! / 60)} мин`);
    expect(goals).not.toMatch(/[⏳⚡] \d+:\d\d/);
  });
});

describe('Брифинг сценария', () => {
  it('«Начать» и подсказка — в подвале, вне прокручиваемого содержимого', () => {
    const { game } = scenarioWithOffers();
    const html = briefHtml(game);
    const foot = html.indexOf('<div class="brief-foot">');
    expect(html.startsWith('<div class="brief-scroll" data-brief-scroll>')).toBe(true);
    expect(foot).toBeGreaterThan(0);
    const tail = html.slice(foot);
    expect(tail).toContain('data-action="begin"');
    expect(tail).toContain('class="tip"');
    expect(html.slice(0, foot)).not.toContain('data-action="begin"');
  });

  it('цели до старта — без пустой полоски и «0 / N», но со сроком, наградой и «почему»', () => {
    const { game, sc } = scenarioWithOffers();
    const html = briefHtml(game);
    const goals = html.slice(html.indexOf('class="brief-goals"'), html.indexOf('Стартовый контракт'));
    expect(goals).not.toContain('sc-bar');
    expect(goals).not.toContain('<b>0 / ');
    expect(goals).toContain('sc-reward');
    expect(goals).toContain('class="sc-why"');
    // Панель сценария по-прежнему с полоской и прогрессом.
    expect(leftPanelHtml(game, view())).toContain('sc-bar');
    expect(sc.offers.length).toBeGreaterThan(0);
    expect(html).toContain('можно решить позже');
  });
});
