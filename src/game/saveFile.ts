/**
 * Текст файла сохранения для «Открыть из файла»: обычный JSON или он же в gzip — так его отдаёт доска задач
 * (баг-репорт грузит сохранение со сжатием, и по ссылке скачивается «…-save.json.gz»). Сжатый файл узнаём
 * по первым байтам, а не по имени: браузер мог и переименовать.
 */
export async function saveFileText(file: Blob): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (head[0] !== 0x1f || head[1] !== 0x8b) return file.text();
  return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
