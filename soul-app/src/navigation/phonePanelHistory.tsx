import React from 'react';
import { ROOT_TAB_ORDER } from './tabContract';

export type PhoneRootTab = (typeof ROOT_TAB_ORDER)[number];
export type PhoneReturnTab = Exclude<PhoneRootTab, 'ChatTab'>;

export interface PhonePanelHistory {
  recordFocus(tab: PhoneRootTab): void;
  getReturnTab(): PhoneReturnTab;
}

const FALLBACK_RETURN_TAB: PhoneReturnTab = 'FeedTab';

export function createPhonePanelHistory(): PhonePanelHistory {
  let activeTab: PhoneRootTab | null = null;
  let returnTab: PhoneReturnTab = FALLBACK_RETURN_TAB;

  return {
    recordFocus(tab) {
      if (tab === 'ChatTab' && activeTab && activeTab !== 'ChatTab') {
        returnTab = activeTab;
      }
      activeTab = tab;
    },
    getReturnTab() {
      return returnTab;
    },
  };
}

const PhonePanelHistoryContext = React.createContext<PhonePanelHistory | null>(null);

export function PhonePanelHistoryProvider({ children }: { children: React.ReactNode }) {
  const [history] = React.useState(createPhonePanelHistory);
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
