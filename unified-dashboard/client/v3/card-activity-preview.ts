import type { CardActivity } from "@seosoyoung/soul-ui/cards/card-types";

/** Parse HTML in an inert document and return text only; never mount report HTML. */
export function cardActivityPreview(activity: Pick<CardActivity, "body" | "format">): string {
  if (activity.format !== "html") return activity.body;
  const parsed = new DOMParser().parseFromString(activity.body, "text/html");
  parsed.querySelectorAll("script,style,template,head").forEach(node => node.remove());
  parsed.querySelectorAll("br,p,div,li,h1,h2,h3,h4,h5,h6,tr").forEach(node => node.append(parsed.createTextNode("\n")));
  return (parsed.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
