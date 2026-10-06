import React, { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { CollapsibleCaptionTrigger } from './CollapsibleCaption';

interface Props {
  count: number;
  children: ReactNode;
}

export function AgentMessageGroup({ count, children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const title = `다른 세션 메시지 ${count}건`;

  return (
    <View testID="agent-message-group">
      <CollapsibleCaptionTrigger
        title={title}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        align="start"
        alignmentInset="content"
      />
      {expanded ? <View>{children}</View> : null}
    </View>
  );
}
