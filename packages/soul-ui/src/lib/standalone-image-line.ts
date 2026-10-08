export interface StandaloneImageLine {
  alt: string;
  url: string;
}

const IMAGE_LINE = /^ {0,3}!\[([^\]]*)\]\(((?:https?:\/\/|\/)[^\s)]+)(?:[ \t]+"[^"]*")?\)[ \t]*$/;

export function parseStandaloneImageLine(line: string): StandaloneImageLine | null {
  const match = IMAGE_LINE.exec(line);
  return match ? { alt: match[1], url: match[2] } : null;
}
