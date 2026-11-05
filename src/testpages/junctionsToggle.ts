import { junctionMarksSvg, onPrefs, overridePref, prefOn } from '../ui/prefs';

/**
 * Переключатель разметки перекрёстков на странице /test/junctions: кнопка в левом верхнем углу и клавиша J —
 * сравнить перекрёстки с разметкой и без неё. На этой странице разметка включена с загрузки. Переключение — только
 * здесь до перезагрузки (`overridePref`, ничего не сохраняет): настройку игры (Меню → Настройки) не трогает.
 */

const PREF = 'junctionMarks';

overridePref(PREF, true);

const style = document.createElement('style');
style.textContent = `
  #junction-marks-toggle {
    position: fixed; left: 12px; top: 64px; z-index: 30;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 12px 7px 9px; border-radius: 10px; border: 2px solid transparent;
    font: 600 14px system-ui, -apple-system, sans-serif; cursor: pointer;
    background: rgba(35, 45, 60, 0.88); color: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  }
  #junction-marks-toggle.on { border-color: #f2c94c; }
  #junction-marks-toggle .state { min-width: 38px; padding: 1px 6px; border-radius: 6px; background: #6b7280; text-align: center; }
  #junction-marks-toggle.on .state { background: #f2c94c; color: #1f2933; }
  #junction-marks-toggle kbd {
    font: 600 12px system-ui, sans-serif; padding: 1px 6px; border-radius: 4px;
    background: rgba(255, 255, 255, 0.16); border: 1px solid rgba(255, 255, 255, 0.35);
  }
`;
document.head.append(style);

const button = document.createElement('button');
button.id = 'junction-marks-toggle';
button.type = 'button';
document.body.append(button);

function render(): void {
  const on = prefOn(PREF);
  button.classList.toggle('on', on);
  button.innerHTML = `${junctionMarksSvg(28, 21)}<span>Разметка перекрёстков:</span><span class="state">${on ? 'вкл' : 'выкл'}</span><kbd>J</kbd>`;
  button.title = `Разметка перекрёстков: штриховка пустого асфальта и направляющие — ${on ? 'выключить' : 'включить'} на этой странице (J)`;
}

const toggle = () => overridePref(PREF, !prefOn(PREF));

button.addEventListener('click', (e) => {
  toggle();
  // Фокус не остаётся на кнопке: пробел и Enter — снова игре.
  (e.currentTarget as HTMLElement).blur();
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyJ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)) return;
  toggle();
});
onPrefs(render);
render();
