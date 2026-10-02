import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ReadOnlyCardList} from '../../../unified-dashboard/client/v3/ReadOnlyCardList';
import {createWidgetBridge,type WidgetState} from './widget-bridge';
const root=createRoot(document.getElementById('root')!);
let refresh=()=>{};
function render(state:WidgetState){
 flushSync(()=>root.render(<main className="v3-shell widget-shell">
  <div className="v3-detail-scroll"><ReadOnlyCardList cards={state.cards} total={state.total} hasData={state.hasData}
   disabled={state.disposed} refresh={state.sync?{pending:state.pending,onRefresh:()=>refresh()}:undefined}
   notice={state.notice} summaryOverride={state.summaryOverride}/>
   <footer id="sync-status" className="widget-meta">{state.syncText}</footer>
  </div>
 </main>));
}
refresh=createWidgetBridge(render).refresh;
