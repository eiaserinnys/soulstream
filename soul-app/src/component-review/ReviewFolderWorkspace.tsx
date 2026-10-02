import React,{useMemo} from 'react';
import {FolderWorkspace} from '../components/planner/FolderWorkspace';
import {createReviewApi,folders} from './fixtures';
/** Actual folder owner, including its one vertical list, header and footer. */
export function ReviewFolderWorkspace(){
  const api=useMemo(()=>createReviewApi('normal',{manyCompleted:true}),[]);
  return <FolderWorkspace api={api} folderId={folders[0].id} folderPageId="public-page"/>;
}
