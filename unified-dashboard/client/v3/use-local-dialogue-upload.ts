import { useState } from "react";
import type { UploadedFile, UseFileUploadReturn } from "@seosoyoung/soul-ui/hooks/useFileUpload";
/** The same upload controller contract, with files retained in this mounted sample. */
export function useLocalDialogueUpload(): UseFileUploadReturn {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  return {
    files,
    isUploading: false,
    isReady: true,
    uploadedPaths: files.map((file) => file.path!),
    addFiles: (incoming) =>
      setFiles((current) => [
        ...current,
        ...Array.from(incoming).map((file) => ({
          id: crypto.randomUUID(),
          file,
          status: "done" as const,
          path: `/sample/${file.name}`,
        })),
      ]),
    removeFile: (id) => setFiles((current) => current.filter((file) => file.id !== id)),
    resetLocal: () => setFiles([]),
    cancel: async () => setFiles([]),
    restoreUploadedFiles: setFiles,
  };
}
