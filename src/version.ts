/**
 * Версия игры — semver «MAJOR.MINOR.PATCH». MAJOR.MINOR и начальный PATCH задаёт поле version в package.json;
 * PATCH растёт сам — на число коммитов после того, как это поле меняли (vite.config.ts, appVersion). Новую
 * MINOR (заметные новые возможности) или MAJOR поднимают в package.json вручную, PATCH при этом снова с нуля.
 * На локальном сервере к версии добавляется «-dev».
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';
