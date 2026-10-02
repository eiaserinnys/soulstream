import {useRef} from "react";
import {Button,FileAttachmentPreview} from "@seosoyoung/soul-ui";
import type {UploadedFile} from "@seosoyoung/soul-ui/hooks/useFileUpload";

/** The actual attachment controls shared by new session and new card. */
export function SessionAttachmentFields({files,pending,nodeId,isUploading,addFiles,removeFile}: {
 files:UploadedFile[];pending:boolean;nodeId:string;isUploading:boolean;
 addFiles(files:FileList|File[]):void;removeFile(id:string):void;
}) {
 const fileInput=useRef<HTMLInputElement>(null);
 return (
            <div className="flex min-w-0 flex-col gap-2">
              {files.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {files.map((file) => (
                    <FileAttachmentPreview
                      key={file.id}
                      file={file.file}
                      status={file.status}
                      onRemove={() => removeFile(file.id)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || !nodeId}
                  onClick={() => fileInput.current?.click()}
                >
                  파일 첨부
                </Button>
                {isUploading ? <small>업로드 중…</small> : null}
              </div>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files?.length) addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
 );
}
