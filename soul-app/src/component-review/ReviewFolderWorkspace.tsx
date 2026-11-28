import { useMemo } from 'react';
import {FolderWorkspace} from '../components/planner/FolderWorkspace';
import {createReviewApi,folders,type FolderSessionPageScenario} from './fixtures';
import {withFolderContext} from './folder-context-fixtures';
export function ReviewFolderWorkspace(){
  const api=useMemo(()=>{
    const requestedScenario=typeof window==='undefined'?null:new URLSearchParams(window.location.search).get('folderSessionPages');
    const folderSessionPages:FolderSessionPageScenario|undefined=requestedScenario==='many'||requestedScenario==='short'?requestedScenario:undefined;
    return withFolderContext(createReviewApi('normal',{manyCompleted:true,folderSessionPages,onFolderSessionPageRequest:(pageId,cursor,releaseResponse)=>{
      if(typeof window==='undefined')return;
      const target=window as Window&{__folderSessionPageRequests?:Array<{pageId:string;cursor:string|null}>;__releaseFolderSessionPageTwo?:Array<()=>void>};
      (target.__folderSessionPageRequests??=[]).push({pageId,cursor});
      if(releaseResponse)(target.__releaseFolderSessionPageTwo??=[]).push(releaseResponse);
    }}));
  },[]);
  return <FolderWorkspace api={api} folderId={folders[0].id} folderPageId="public-page"/>;
}
