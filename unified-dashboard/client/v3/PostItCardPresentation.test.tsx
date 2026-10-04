import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {PostItCardView} from './PostItCardPresentation';

it('readonly cards retain the shared frame and text without activity labels, fake actions or portrait requests',()=>{
 const html=renderToStaticMarkup(createElement(PostItCardView,{id:'a',title:'긴 한국어 제목',status:'review',fontSize:14,
 activity:{kind:'report',text:'<img src=x onerror=evil()> 실제 보고'},assigneeName:'담당',readOnly:true,showStatus:false,
  statusContent:createElement('button',null,'상태'),avatar:createElement('img',{src:'/private'})}));
 expect(html).toContain('v3-postit-card');expect(html).not.toContain('v3-postit-latest-label');expect(html).not.toContain('마지막 보고');expect(html).toContain('&lt;img');
 expect(html).not.toMatch(/<button|<img|status-chip|열기/);
 expect(html).toContain('data-card-readonly="true"');
});

it('uses the persisted paper color from the shared wire schema and keeps missing colors yellow',()=>{
 const colored=renderToStaticMarkup(createElement(PostItCardView,{id:'pink-card',title:'연분홍 카드',status:'todo',fontSize:14,
  activity:null,assigneeName:'담당',color:'pink'}));
 const legacy=renderToStaticMarkup(createElement(PostItCardView,{id:'legacy-card',title:'기존 카드',status:'todo',fontSize:14,
  activity:null,assigneeName:'담당'}));
 expect(colored).toContain('data-card-color="pink"');
 expect(colored).toContain('--postit-paper:#ffede8');
 expect(legacy).toContain('data-card-color="yellow"');
 expect(legacy).toContain('--postit-paper:#fff7c6');
});
