import './buildingTool.css';
import type { Game } from '../game/game';
import type { Controller } from '../input/controller';
import type { Camera } from '../render/camera';
import { drawHouseArt } from '../render/houseArt';
import type { HouseForm, TownBuilding } from '../world/entities';
import { BUILDING_SIZE } from '../world/buildingResize';
import { FORM_NAMES } from '../world/townForms';
import { defaultTestBuildingOptions, nextTestBuilding, planTestBuilding, placeTestBuilding, testBuildingBlueprint, TEST_BUILDING_FORMS, type TestBuildingOptions } from './testBuildings';

/** Тестовый редактор застройки: все типы из игрового каталога, реальные планировки и подъезды. */
export function installBuildingTool(host: { game(): Game; enabled(): boolean; controller: Controller; camera: Camera; canvas: HTMLCanvasElement }): { update(): void } {
  const toolbar = document.querySelector<HTMLElement>('[data-tools]')!;
  const button = document.createElement('button');
  button.className = 'tool';
  button.title = 'Поставить любое здание на тестовую сцену';
  button.setAttribute('aria-pressed', 'false');
  button.innerHTML = '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M3 25V10L13 3L23 10V25M8 25V17H15V25M18 12H21M18 17H21M18 21H21M6 12H10" stroke-width="2" fill="none"/></svg><span class="name">Здания</span>';
  toolbar.insertBefore(button, toolbar.querySelector('[data-id="select"]'));
  toolbar.classList.add('test-building-toolbar');
  const palette = document.createElement('section');
  palette.className = 'panel test-buildings';
  palette.setAttribute('aria-label', 'Здания для тестирования');
  palette.innerHTML = `<header><b>Здания</b><button type="button" data-close aria-label="Закрыть выбор зданий">✕</button></header>
    <div class="test-building-types">${TEST_BUILDING_FORMS.map((form) => `<button type="button" data-form="${form}"><canvas width="100" height="72" aria-hidden="true"></canvas><span>${FORM_NAMES[form]}</span></button>`).join('')}</div>
    <div class="test-building-settings">
      <label>Вариант<input name="variant" type="number" min="1" max="1000" value="1"></label>
      <label>Ширина участка<input name="width" type="number" min="${BUILDING_SIZE.width.min}" max="${BUILDING_SIZE.width.max}" step="${BUILDING_SIZE.step}"></label>
      <label>Глубина участка<input name="depth" type="number" min="${BUILDING_SIZE.depth.min}" max="${BUILDING_SIZE.depth.max}" step="${BUILDING_SIZE.step}"></label>
      <label>Этажи<input name="floors" type="number" min="1" max="25"></label>
      <label data-private>Место машины<select name="parking"><option value="any">Любое</option><option value="garage">Гараж</option><option value="pad">Площадка</option><option value="none">Без места</option></select></label>
      <label data-private>Дом на участке<select name="side"><option value="any">Любая сторона</option><option value="left">Слева</option><option value="right">Справа</option></select></label>
      <label data-private>Мест на участке<select name="homeSpaces"><option value="1">1 место</option><option value="2">2 места</option><option value="3">3 места</option></select></label>
      <label data-garage>Из них в гараже<select name="garageSpaces"><option value="1">1 место</option><option value="2">2 места</option></select></label>
      <label data-hospital>Места скорых<input name="bays" type="number" min="2" max="6"></label>
      <label>Стены<input name="color" type="color"></label><label>Крыша<input name="roof" type="color"></label>
    </div><output>Кликните у улицы. Колесо — масштаб, правая протяжка — карта, Esc или правый клик — отмена.</output>`;
  document.body.append(palette);
  let open = false;
  let options = defaultTestBuildingOptions('cottage');
  let blueprint: TownBuilding | null = null;
  let blueprintGame: Game | null = null;
  let message = '';
  let rightDown: { x: number; y: number } | null = null;
  const preview = () => {
    const p = host.controller.hover;
    const plan = p && blueprint ? planTestBuilding(host.game(), blueprint, p) : null;
    return plan ? { building: plan.building, ok: plan.ok, label: plan.label } : { building: null, ok: false, label: blueprint ? 'Поставьте здание рядом с улицей' : 'Для выбранного участка такая комбинация не помещается' };
  };
  function createBlueprint(): void {
    blueprintGame = host.game();
    blueprint = nextTestBuilding(blueprintGame, options);
    message = blueprint ? '' : 'Такая комбинация не помещается на участке. Увеличьте участок или измените место машины.';
    if (open) host.controller.testBuildingPreview = () => preview();
  }
  function syncFields(): void {
    for (const key of ['variant', 'width', 'depth', 'floors', 'parking', 'side', 'homeSpaces', 'garageSpaces', 'color', 'roof', 'bays'] as const) (palette.querySelector(`[name="${key}"]`) as HTMLInputElement | HTMLSelectElement).value = String(options[key]);
    for (const element of palette.querySelectorAll<HTMLElement>('[data-private]')) element.hidden = options.form !== 'cottage' && options.form !== 'dacha';
    palette.querySelector<HTMLOptionElement>('[name="parking"] [value="garage"]')!.hidden = options.form === 'dacha';
    palette.querySelector<HTMLElement>('[data-garage]')!.hidden = options.form !== 'cottage' || (options.parking !== 'any' && options.parking !== 'garage');
    palette.querySelector<HTMLSelectElement>('[name="homeSpaces"]')!.disabled = options.parking === 'none';
    palette.querySelector<HTMLOptionElement>('[name="garageSpaces"] [value="2"]')!.disabled = options.homeSpaces < 2;
    palette.querySelector<HTMLElement>('[data-hospital]')!.hidden = options.form !== 'hospital';
  }
  function setOpen(value: boolean): void {
    open = value;
    if (open) {
      window.dispatchEvent(new CustomEvent('roads-test-tool', { detail: 'buildings' }));
      host.controller.setTool('select'); host.controller.select(null);
      if (!blueprint || blueprintGame !== host.game()) createBlueprint();
    }
    document.body.toggleAttribute('data-test-building', open);
    host.controller.testBuildingPreview = open ? preview : null;
    update();
  }
  button.addEventListener('click', () => setOpen(!open));
  window.addEventListener('roads-test-tool', (e) => { if ((e as CustomEvent<string>).detail !== 'buildings' && open) setOpen(false); });
  toolbar.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('button')?.isSameNode(button)) setOpen(false); });
  palette.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (target?.hasAttribute('data-close')) setOpen(false);
    else if (target?.dataset.form && TEST_BUILDING_FORMS.includes(target.dataset.form as HouseForm)) {
      options = defaultTestBuildingOptions(target.dataset.form as HouseForm);
      syncFields(); createBlueprint(); update();
    }
  });
  palette.addEventListener('change', () => {
    const numeric = (name: string, lo: number, hi: number, step = 1) => Math.max(lo, Math.min(hi, Math.round((Number((palette.querySelector(`[name="${name}"]`) as HTMLInputElement).value) || lo) / step) * step));
    const value = (name: string) => (palette.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement).value;
    const homeSpaces = numeric('homeSpaces', 1, 3) as 1 | 2 | 3;
    const garageSpaces = Math.min(numeric('garageSpaces', 1, 2), homeSpaces) as 1 | 2;
    const { width, depth, step } = BUILDING_SIZE;
    options = { ...options, variant: numeric('variant', 1, 1000), width: numeric('width', width.min, width.max, step), depth: numeric('depth', depth.min, depth.max, step), floors: numeric('floors', 1, 25), bays: numeric('bays', 2, 6), parking: value('parking') as TestBuildingOptions['parking'], side: value('side') as TestBuildingOptions['side'], homeSpaces, garageSpaces, color: value('color'), roof: value('roof') };
    syncFields(); createBlueprint(); update();
  });
  palette.addEventListener('keydown', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); }
  }, { capture: true });
  host.canvas.addEventListener('mousedown', (e) => { if (e.button === 2) rightDown = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', (e) => {
    if (e.button !== 2) return;
    if (open && rightDown && Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y) < 4) setOpen(false);
    rightDown = null;
  }, { capture: true });
  for (const type of ['pointerdown', 'pointerup'] as const) host.canvas.addEventListener(type, (e) => {
    if (!open || !host.enabled() || e.button !== 0) return;
    const at = host.camera.toWorld(e.clientX, e.clientY);
    if (type === 'pointerdown' && host.game().structureAt(at)?.type === 'building') {
      setOpen(false);
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (type === 'pointerup') return;
    if (blueprintGame !== host.game()) createBlueprint();
    if (!blueprint) return;
    const plan = planTestBuilding(host.game(), blueprint, at);
    const placed = placeTestBuilding(host.game(), plan);
    if (placed) { host.controller.select({ type: 'building', id: placed.id }); createBlueprint(); message = `${FORM_NAMES[options.form]} добавлен`; }
    else message = plan.label;
    update();
  }, { capture: true });
  for (const element of palette.querySelectorAll<HTMLButtonElement>('[data-form]')) {
    const form = element.dataset.form as HouseForm;
    const canvas = element.querySelector('canvas')!;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    const o = defaultTestBuildingOptions(form);
    const b = testBuildingBlueprint(503, o);
    ctx.save(); ctx.translate(50, 37); ctx.scale(0.6, 0.6); drawHouseArt(ctx, b, 0.6); ctx.restore();
  }
  syncFields();
  function update(): void {
    button.hidden = !host.enabled();
    palette.hidden = !open || button.hidden;
    button.classList.toggle('active', open && !button.hidden);
    button.setAttribute('aria-pressed', String(open && !button.hidden));
    for (const element of palette.querySelectorAll<HTMLButtonElement>('[data-form]')) element.setAttribute('aria-pressed', String(element.dataset.form === options.form));
    palette.querySelector('output')!.textContent = message || 'Кликните у улицы. Колесо — масштаб, правая протяжка — карта, Esc или правый клик — отмена.';
    if (open && (host.controller.tool !== 'select' || !host.enabled() || host.controller.pending || document.body.hasAttribute('data-test-vehicle'))) setOpen(false);
  }
  update();
  return { update };
}
