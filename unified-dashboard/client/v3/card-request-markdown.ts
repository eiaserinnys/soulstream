export function cardRequestMarkdown(request: string): string {
 return request.replace(/^첨부: (.+)\((https?:\/\/[^\s]+)\)$/gm, (_, name: string, url: string) => {
  const label = name.replace(/[\[\]\\]/g, "\\$&");
  const image = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name);
  return `첨부: ${image ? "!" : ""}[${label}](${url})`;
 });
}
