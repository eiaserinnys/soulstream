import {readFileSync,writeFileSync} from 'node:fs';
writeFileSync(new URL('../src/widget-html.ts',import.meta.url),'// Generated from public/cards.html; no runtime asset path needed.\nexport const widgetHtml = '+JSON.stringify(readFileSync(new URL('../public/cards.html',import.meta.url),'utf8'))+';\n');
