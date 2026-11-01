import React from 'react';
import { ROOT_TAB_ORDER } from './tabContract';

export type PhoneRootTab = (typeof ROOT_TAB_ORDER)[number];
export type PhoneReturnTab = PhoneRootTab;

export interface PhonePanelHistory {
  recordFocus(tab: PhoneRootTab): void;
  recordChatOpen(origin?: PhoneReturnTab): void;
  getReturnTab(): PhoneReturnTab;
  hasReturnTab(): boolean;
}

const FALLBACK_RETURN_TAB: PhoneReturnTab = 'FeedTab';

export function createPhonePanelHistory(): PhonePanelHistory {
  let activeTab: PhoneRootTab | null = null;
  let returnTab: PhoneReturnTab = FALLBACK_RETURN_TAB;
  let hasReturnTab = false;

  return {
    recordFocus(tab) {
      activeTab = tab;
    },
    recordChatOpen(origin) {
      returnTab = origin ?? activeTab ?? returnTab;
      hasReturnTab = true;
      activeTab = null;
    },
    getReturnTab() {
      return returnTab;
    },
    hasReturnTab() {
      return hasReturnTab;
    },
  };
}

const PhonePanelHistoryContext = React.createContext<PhonePanelHistory | null>(null);

export function PhonePanelHistoryProvider({ children }: { children: React.ReactNode }) {
  const inherited = React.useContext(PhonePanelHistoryContext);
  const [local] = React.useState(createPhonePanelHistory);
  const history = inherited ?? local;
  return (
    <PhonePanelHistoryContext.Provider value={history}>
      {children}
    </PhonePanelHistoryContext.Provider>
  );
}

export function usePhonePanelHistory(): PhonePanelHistory {
  const history = React.useContext(PhonePanelHistoryContext);
  if (!history) {
    throw new Error('PhonePanelHistoryProvider가 필요합니다.');
  }
  return history;
}
