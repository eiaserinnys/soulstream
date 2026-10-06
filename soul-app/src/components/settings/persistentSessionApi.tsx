import React, { createContext, useContext } from 'react';

import { createApiClient, type ApiClient } from '../../api/client';

type PersistentSessionApiFactory = (serverUrl: string) => ApiClient;
const PersistentSessionApiContext = createContext<PersistentSessionApiFactory>(createApiClient);

export function PersistentSessionApiProvider({ createApi, children }: {
  createApi: PersistentSessionApiFactory;
  children: React.ReactNode;
}) {
  return <PersistentSessionApiContext.Provider value={createApi}>{children}</PersistentSessionApiContext.Provider>;
}

export function usePersistentSessionApiFactory() {
  return useContext(PersistentSessionApiContext);
}
