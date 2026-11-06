import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { clockText, durationText } from '../core/timeText';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from '../world/settings';
import { briefHtml, isFolded, offerBannerHtml, offersPanelHtml, scenarioPanelHtml, toggleFold, type PanelView } from './scenarioUi';

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

describe('Панель предложений контрактов', () => {
  it('показывает все предложения с кнопками, самое срочное — первым; подробности — по раскрытию', () => {
    const { game, sc, extra } = scenarioWithOffers();
    expect(sc.offers.length).toBeGreaterThanOrEqual(2);
    const html = offersPanelHtml(game, new Set());
    for (const o of sc.offers) {
      expect(html).toContain(`data-action="sc-accept" data-id="${o.id}"`);
      expect(html).toContain(`data-action="sc-decline" data-id="${o.id}"`);
      expect(html).toContain(`data-offer="${o.id}"`);
    }
    expect(html.indexOf(`data-id="${extra.id}"`)).toBeLessThan(html.indexOf(`data-id="${sc.offers.find((o) => o !== extra)!.id}"`));
    expect(html).not.toContain('<p class="sc-cause">Город ищет перевозчика.</p>');
    expect(offersPanelHtml(game, new Set([extra.id]))).toContain('<p class="sc-cause">Город ищет перевозчика.</p>');
  });

  it('пуста, когда решать нечего, а в панели сценария кнопок предложений больше нет', () => {
    const { game, sc } = scenarioWithOffers();
    expect(scenarioPanelHtml(game, view())).not.toContain('sc-accept');
    for (const o of [...sc.offers]) sc.decline(o.id);
    expect(offersPanelHtml(game, new Set())).toBe('');
  });
});

describe('Плашка предложения вверху', () => {
  it('уведомляет о самом срочном предложении без кнопок решения, остальные — счётчиком, клик ведёт к панели внизу', () => {
    const { game, sc, extra } = scenarioWithOffers();
    const html = offerBannerHtml(game);
    // Принять или отказаться — только в панели внизу.
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
    const html = scenarioPanelHtml(game, view());
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
    const html = scenarioPanelHtml(game, view());
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
    expect(scenarioPanelHtml(loaded, view())).toContain(`folded" data-action="sc-fold" data-id="${a.id}"`);
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
    const html = scenarioPanelHtml(game, view());
    const row = html.slice(html.indexOf(`data-id="${o.id}"`));
    expect(row).toContain('style="width:50.0%"');
    expect(row).toContain('235 / 470 ед.</b><span class="sc-month">в этом месяце</span>');
    expect(row).not.toContain('1 / 3 мес.');
    expect(row).toMatch(/<span class="sc-streak"[^>]*><i class="on"><\/i><i class=""><\/i><i class=""><\/i><\/span>/);
    toggleFold(o);
    const folded = scenarioPanelHtml(game, view());
    const frow = folded.slice(folded.indexOf(`data-id="${o.id}"`));
    expect(frow).toContain('235 / 470 ед.</b><span class="sc-streak"');
    expect(frow.slice(0, frow.indexOf('</div></div>'))).not.toContain('в этом месяце');
  });
});

describe('Сроки — минутами и секундами, а не месяцами', () => {
  it('до срока задания и до конца предложения — «м:сс», срок контракта и быстрый срок — «N мин»', () => {
    const { game, sc, extra } = scenarioWithOffers();
    // Середина месяца: до начала следующего — ровно 30 с, до конца предложения — столько же.
    game.time = (sc.month + 0.5) * MONTH_LENGTH;
    const goal = sc.current.find((o) => o.deadline !== null)!;
    goal.deadline = sc.month + 4;
    const panel = scenarioPanelHtml(game, view());
    expect(panel).toContain(`⏳ ${clockText(3.5 * MONTH_LENGTH)}`);
    expect(panel).not.toMatch(/\d мес\./);
    const offers = offersPanelHtml(game, new Set());
    expect(offers).toContain(`⌛ ${clockText(0.5 * MONTH_LENGTH)}`);
    expect(offers).toContain(`⏳ ${durationText(extra.months! * MONTH_LENGTH)}`);
    // Меньше минуты на решение — предложение подсвечено.
    expect(offers).toContain(`of-card urgent" data-offer="${extra.id}"`);
    expect(offerBannerHtml(game)).toContain('offer-banner-in urgent');
    expect(offers).not.toMatch(/\d мес\./);
  });

  it('брифинг: ожидаемая продолжительность — в минутах', () => {
    const { game, sc } = scenarioWithOffers();
    expect(briefHtml(game)).toContain(`<b>≈ ${Math.round((sc.state.brief.months * MONTH_LENGTH) / 60)}</b><small>мин</small>`);
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
    expect(scenarioPanelHtml(game, view())).toContain('sc-bar');
    expect(sc.offers.length).toBeGreaterThan(0);
    expect(html).toContain('можно решить позже');
  });
});
