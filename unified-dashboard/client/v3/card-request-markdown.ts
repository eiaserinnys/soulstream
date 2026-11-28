export function cardRequestMarkdown(request: string): string {
 return request.replace(/^첨부: (.+)\((https?:\/\/[^\s]+)\)$/gm, (_, name: string, url: string) => { // i18n-ignore: 기존 카드 요청 마크다운의 첨부 머리말을 찾습니다.
  const label = name.replace(/[\[\]\\]/g, "\\$&");
  const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
  return `첨부: ${image ? "!" : ""}[${label}](${url})`; // i18n-ignore: 기존 카드 요청 마크다운의 첨부 머리말.
 });
}
