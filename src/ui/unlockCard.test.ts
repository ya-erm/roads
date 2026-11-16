import { describe, expect, it } from 'vitest';
import { MODEL_UNLOCK } from '../config';
import { ModelUnlocks } from '../game/unlocks';
import { unlockProgressHtml, unlockTip } from './unlockCard';

describe('Закрытая модель в карточке маршрута', () => {
  it('полоска пути до порога и счёт значком: 👤 у пассажиров, 📦 у грузов', () => {
    const u = new ModelUnlocks();
    u.add('bus', 1240);
    const bus3 = unlockProgressHtml(u.progress('bus3'));
    expect(bus3).toContain(`👤 1 240 / 3 600`);
    expect(bus3).toContain(`width:${Math.round((1240 / MODEL_UNLOCK.bus3) * 1000) / 10}%`);
    u.add('truck', 380);
    expect(unlockProgressHtml(u.progress('truck2'))).toContain('📦 380 / 400');
    // Счёт больше порога (открыто, но спросили) — полоска не вылезает за край.
    u.add('freightTrain', 5_000);
    expect(unlockProgressHtml(u.progress('freightTrain2'))).toContain('width:100%');
  });

  it('подсказка: кто сколько должен перевезти, сколько осталось, что даст модель; у автоцистерны — её название', () => {
    const u = new ModelUnlocks();
    u.add('truck', 380);
    const tip = unlockTip('truck2', u.progress('truck2'), true);
    expect(tip).toContain('Автоцистерна II');
    expect(tip).toContain('грузовики перевезут 400 ед. груза');
    expect(tip).toContain('осталось 20');
    expect(unlockTip('passengerTrain2', u.progress('passengerTrain2'))).toContain('пассажирские поезда перевезут 3 600 пассажиров');
  });
});
