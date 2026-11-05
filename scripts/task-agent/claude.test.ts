import { describe, expect, it } from 'vitest';
import { outageOf } from './claude';

describe('Claude недоступен вообще или не справился с задачей', () => {
  it('по коду ошибки API', () => {
    expect(outageOf('authentication_failed')).toMatch(/claude auth login/);
    expect(outageOf('rate_limit')).toMatch(/лимит/);
    expect(outageOf('billing_error')).toMatch(/оплат/);
    expect(outageOf('server_error')).toMatch(/не отвечает/);
  });

  it('без кода — по тексту ошибки', () => {
    expect(outageOf(undefined, 'Failed to authenticate: OAuth session expired and could not be refreshed')).toMatch(/claude auth login/);
    expect(outageOf(undefined, 'Not logged in · Please run /login')).toMatch(/claude auth login/);
    expect(outageOf(undefined, 'Claude AI usage limit reached|1793800000')).toMatch(/лимит/);
  });

  it('ошибки самой задачи — не сбой Claude', () => {
    expect(outageOf('invalid_request', 'prompt is too long')).toBeUndefined();
    expect(outageOf(undefined, 'превышено время работы (120 мин)')).toBeUndefined();
    expect(outageOf(undefined, 'нет структурированного ответа')).toBeUndefined();
  });
});
